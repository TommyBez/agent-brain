import type {
  AnalysisResult,
  AnalysisTask,
  ApplyResult,
  ChangeSet,
  DecisionRecord,
  Draft,
  OperationPlan,
  Snapshot,
  Verification,
} from "./types";

export type Scan = {
  tasks: AnalysisTask[];
  cached: AnalysisResult[];
  total: number;
  remaining: number;
};
export type RunSummary = {
  report: string;
  status: "succeeded" | "partial";
  writes: number;
  waves: number;
  evaluatedTasks: number;
  reusedTasks: number;
  totalTasks: number;
  remainingTasks: number;
  findings: number;
  unresolved: number;
  proposed: number;
  rejected: number;
  conflicts: number;
  errors: number;
  stoppedBy: "stable" | "limit" | "incomplete";
};

/** Callbacks are durable steps in production and explicit fakes in unit tests. */
export type RunnerSteps = {
  snapshot(): Promise<Snapshot>;
  scan(snapshot: Snapshot, remainingBudget: number): Promise<Scan>;
  analyze(snapshot: Snapshot, task: AnalysisTask): Promise<AnalysisResult>;
  plan(
    snapshot: Snapshot,
    results: AnalysisResult[],
  ): Promise<{ selected: OperationPlan[]; deferred: number }>;
  draft(
    snapshot: Snapshot,
    plan: OperationPlan,
    attempt: number,
    feedback?: string[],
  ): Promise<Draft>;
  review(
    snapshot: Snapshot,
    plan: OperationPlan,
    draft: Draft,
  ): Promise<{ changeSet: ChangeSet | null; verification: Verification }>;
  expand(
    snapshot: Snapshot,
    plan: OperationPlan,
    depth: number,
  ): Promise<OperationPlan | null>;
  apply(changeSet: ChangeSet): Promise<ApplyResult>;
  record(key: string, value: unknown): Promise<void>;
};

async function mapBounded<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const result: R[] = [];
  // Fixed batches are deterministic across Workflow replays.
  for (let index = 0; index < items.length; index += concurrency) {
    result.push(
      ...(await Promise.all(items.slice(index, index + concurrency).map(task))),
    );
  }
  return result;
}

export async function runConsolidation(
  steps: RunnerSteps,
  options: {
    maxWaves: number;
    taskBudget: number;
    concurrency: number;
    repairs: number;
    expansions: number;
  },
): Promise<RunSummary> {
  const summary: RunSummary = {
    report: "",
    status: "succeeded",
    writes: 0,
    waves: 0,
    evaluatedTasks: 0,
    reusedTasks: 0,
    totalTasks: 0,
    remainingTasks: 0,
    findings: 0,
    unresolved: 0,
    proposed: 0,
    rejected: 0,
    conflicts: 0,
    errors: 0,
    stoppedBy: "stable",
  };
  for (let wave = 0; wave < options.maxWaves; wave++) {
    summary.waves++;
    const snapshot = await steps.snapshot();
    const scan = await steps.scan(
      snapshot,
      Math.max(0, options.taskBudget - summary.evaluatedTasks),
    );
    summary.totalTasks = scan.total;
    summary.reusedTasks += scan.cached.length;
    summary.remainingTasks = scan.remaining;
    const results = await mapBounded(
      scan.tasks,
      options.concurrency,
      async (task) => {
        try {
          const result = await steps.analyze(snapshot, task);
          if (result.status === "incomplete") {
            summary.errors++;
            summary.remainingTasks++;
          }
          return result;
        } catch {
          summary.errors++;
          summary.remainingTasks++;
          await steps.record(`analysis-error:${snapshot.id}:${task.id}`, {
            taskId: task.id,
            status: "error",
          });
          return {
            taskId: task.id,
            findings: [],
            judgments: [],
            status: "incomplete",
          } satisfies AnalysisResult;
        }
      },
    );
    summary.evaluatedTasks += scan.tasks.length;
    const all = [...scan.cached, ...results];
    summary.findings += all.reduce(
      (count, result) => count + result.findings.length,
      0,
    );
    summary.unresolved += all.reduce(
      (count, result) =>
        count +
        result.findings.filter((finding) => finding.status === "uncertain")
          .length,
      0,
    );
    let plans = await steps.plan(snapshot, all);
    const planCapacity = plans.selected.length + plans.deferred;
    const attemptedPlans = new Set<string>();
    let changed = false;
    // Rejections and no-ops do not evolve the snapshot. Drain their deferred
    // neighbours without spending a mutation wave or repeating analysis.
    while (true) {
      const pending = plans.selected.length + plans.deferred;
      const selectedIds = plans.selected.map((plan) => plan.id);
      if (
        !Number.isInteger(plans.deferred) ||
        plans.deferred < 0 ||
        attemptedPlans.size + pending > planCapacity ||
        new Set(selectedIds).size !== selectedIds.length ||
        selectedIds.some((id) => attemptedPlans.has(id)) ||
        (plans.deferred > 0 && !plans.selected.length)
      ) {
        summary.errors++;
        await steps.record(`planning-error:${snapshot.id}`, {
          status: "error",
          reason: "Deferred planning failed its bounded progress invariant.",
          attemptedPlans: attemptedPlans.size,
          planCapacity,
        });
        break;
      }
      for (const initial of plans.selected) {
        attemptedPlans.add(initial.id);
        summary.proposed++;
        let plan = initial;
        let decision: DecisionRecord = {
          operationId: initial.id,
          status: "error",
        };
        try {
          let draft = await steps.draft(snapshot, plan, 0);
          let repair = 0;
          let expansion = 0;
          while (true) {
            if (draft.noChange) {
              decision = { operationId: initial.id, status: "no_change" };
              break;
            }
            const reviewed = await steps.review(snapshot, plan, draft);
            if (reviewed.verification.incomplete) {
              summary.errors++;
              decision = {
                operationId: initial.id,
                status: "error",
                verification: reviewed.verification,
                reason:
                  "Verification coverage incomplete; operation was not applied.",
              };
              break;
            }
            if (
              reviewed.verification.status === "accepted" &&
              reviewed.changeSet
            ) {
              const applied = await steps.apply(reviewed.changeSet);
              if (applied.status === "conflict") {
                summary.conflicts++;
                decision = {
                  operationId: initial.id,
                  status: "conflict",
                  reason:
                    "Evidence or target changed; reanalyse current state.",
                };
                changed = true;
              } else {
                summary.writes += applied.pages.length;
                changed = true;
                decision = {
                  operationId: initial.id,
                  status: "applied",
                  ...reviewed,
                  changeSet: reviewed.changeSet,
                };
              }
              break;
            }
            if (
              reviewed.verification.status === "uncertain" &&
              expansion < options.expansions
            ) {
              let expanded: OperationPlan | null = null;
              while (!expanded && expansion < options.expansions) {
                expanded = await steps.expand(snapshot, plan, ++expansion);
              }
              if (expanded) {
                plan = expanded;
                continue;
              }
            }
            if (
              reviewed.verification.status === "rejected" &&
              repair < options.repairs
            ) {
              draft = await steps.draft(
                snapshot,
                plan,
                ++repair,
                reviewed.verification.defects,
              );
              continue;
            }
            if (reviewed.verification.status === "uncertain")
              summary.unresolved++;
            else summary.rejected++;
            decision = {
              operationId: initial.id,
              status:
                reviewed.verification.status === "uncertain"
                  ? "uncertain"
                  : "rejected",
              verification: reviewed.verification,
              ...(reviewed.changeSet ? { changeSet: reviewed.changeSet } : {}),
            };
            break;
          }
        } catch {
          summary.errors++;
          decision = {
            operationId: initial.id,
            status: "error",
            reason:
              "Operation failed; document unchanged unless an idempotent writer receipt exists.",
          };
        }
        await steps.record(`decision:${initial.id}`, {
          ...decision,
          evidenceVersions: plan.readSet,
        });
      }
      if (
        changed ||
        summary.errors > 0 ||
        summary.remainingTasks > 0 ||
        plans.deferred === 0
      )
        break;
      try {
        // Recorded terminal decisions must be filtered by the planner; every
        // additional batch must fit the unattempted part of the original set.
        plans = await steps.plan(snapshot, all);
      } catch {
        summary.errors++;
        await steps.record(`planning-error:${snapshot.id}`, {
          status: "error",
          reason: "Deferred planning failed; the snapshot was not advanced.",
          attemptedPlans: attemptedPlans.size,
          planCapacity,
        });
        break;
      }
    }
    await steps.record(`coverage:${wave}`, {
      snapshotId: snapshot.id,
      total: scan.total,
      evaluated: scan.tasks.length,
      reused: scan.cached.length,
      remaining: summary.remainingTasks,
      deferredPlans: plans.deferred,
      attemptedPlans: attemptedPlans.size,
    });
    if (summary.remainingTasks > 0 || summary.errors > 0) {
      summary.stoppedBy = "incomplete";
      break;
    }
    if (!changed && plans.deferred === 0) {
      summary.stoppedBy = "stable";
      break;
    }
    if (wave + 1 === options.maxWaves) summary.stoppedBy = "limit";
  }
  if (summary.remainingTasks || summary.errors || summary.stoppedBy === "limit")
    summary.status = "partial";
  summary.report = `Consolidation: ${summary.writes} page writes. Coverage: ${summary.totalTasks - summary.remainingTasks}/${summary.totalTasks} analysis tasks in the last pass. ${summary.unresolved} unresolved findings, ${summary.rejected} rejected proposals, ${summary.errors} technical errors. Stopped: ${summary.stoppedBy}.`;
  return summary;
}
