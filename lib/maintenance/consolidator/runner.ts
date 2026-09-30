import { failureDiagnostic } from "./diagnostics";
import type {
  AnalysisResult,
  AnalysisTask,
  ApplyResult,
  ChangeSet,
  DecisionRecord,
  Draft,
  DraftOutcome,
  OperationPlan,
  RunHalt,
  Snapshot,
  Verification,
} from "./types";

export type Scan = {
  tasks: AnalysisTask[];
  cached: AnalysisResult[];
  reused: number;
  total: number;
  remaining: number;
};
export type RunSummary = {
  report: string;
  status: "succeeded" | "partial";
  writes: number;
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
  capacityLimited: number;
  stoppedBy:
    | "stable"
    | "budget"
    | "provider"
    | "incomplete"
    | "limit"
    | "changed";
};
export type RunnerSteps = {
  snapshot(): Promise<Snapshot>;
  scan(snapshot: Snapshot, taskBudget: number): Promise<Scan>;
  analyze(
    snapshot: Snapshot,
    task: AnalysisTask,
  ): Promise<AnalysisResult | RunHalt>;
  plan(
    snapshot: Snapshot,
    results: AnalysisResult[],
  ): Promise<{
    selected: OperationPlan[];
    deferred: number;
    capacityLimited?: number;
  }>;
  draft(
    snapshot: Snapshot,
    plan: OperationPlan,
    attempt: number,
    feedback?: string[],
  ): Promise<DraftOutcome>;
  review(
    snapshot: Snapshot,
    plan: OperationPlan,
    draft: Draft,
  ): Promise<
    { changeSet: ChangeSet | null; verification: Verification } | RunHalt
  >;
  apply(changeSet: ChangeSet): Promise<ApplyResult>;
  record(key: string, value: unknown): Promise<void>;
  queue(completedTaskIds: string[]): Promise<void>;
};

/** One snapshot per night. Complete each intervention before spending on the next task. */
export async function runConsolidation(
  steps: RunnerSteps,
  options: { taskBudget: number; repairs: number },
): Promise<RunSummary> {
  const summary: RunSummary = {
    report: "",
    status: "succeeded",
    writes: 0,
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
    capacityLimited: 0,
    stoppedBy: "stable",
  };
  const snapshot = await steps.snapshot();
  const scan = await steps.scan(snapshot, options.taskBudget);
  summary.totalTasks = scan.total;
  const cached = new Map(scan.cached.map((result) => [result.taskId, result]));
  const order = scan.tasks.map((task) => task.id);
  const remaining = new Set(order);
  summary.reusedTasks = scan.reused;
  const changed = new Set<string>();
  const completedReads = new Map<string, string[]>();
  let consecutiveProviderErrors = 0;
  for (const task of scan.tasks) {
    const id = task.id;
    let result = cached.get(id);
    const reads =
      result?.dependencies?.map((ref) => ref.pageId) ?? task.pageIds;
    if (reads.some((id) => changed.has(id))) continue;
    let stage = "analysis";
    let operationId: string | undefined;
    try {
      if (!result) {
        const analyzed = await steps.analyze(snapshot, task);
        if ("halt" in analyzed) {
          summary.stoppedBy = analyzed.halt;
          break;
        }
        result = analyzed;
        summary.evaluatedTasks++;
      }
      completedReads.set(
        id,
        result.dependencies?.map((ref) => ref.pageId) ?? reads,
      );
      summary.findings += result.findings.length;
      summary.unresolved += result.findings.filter(
        (finding) => finding.status === "uncertain",
      ).length;
      if (result.status === "incomplete") {
        summary.errors++;
        consecutiveProviderErrors = 0;
        continue;
      }
      // A specifically referenced evidence page may have been edited earlier tonight.
      if (result.dependencies?.some((ref) => changed.has(ref.pageId))) continue;
      if (!result.findings.some((finding) => finding.status === "supported")) {
        remaining.delete(id);
        consecutiveProviderErrors = 0;
        continue;
      }
      stage = "planning";
      const plans = await steps.plan(snapshot, [result]);
      summary.capacityLimited += plans.capacityLimited ?? 0;
      let deferred = plans.deferred > 0;
      for (const plan of plans.selected) {
        if (plan.readSet.some((ref) => changed.has(ref.pageId))) {
          deferred = true;
          continue;
        }
        operationId = plan.id;
        stage = "draft";
        summary.proposed++;
        let draft = await steps.draft(snapshot, plan, 0);
        let decision: DecisionRecord | undefined;
        for (let attempt = 0; ; attempt++) {
          if ("halt" in draft) {
            summary.stoppedBy = draft.halt;
            break;
          }
          if ("capacity" in draft) {
            summary.capacityLimited++;
            decision = {
              operationId: plan.id,
              status: "uncertain",
              reason: "capacity",
            };
            break;
          }
          if (draft.noChange) {
            decision = { operationId: plan.id, status: "no_change" };
            break;
          }
          stage = "verification";
          const reviewed = await steps.review(snapshot, plan, draft);
          if ("halt" in reviewed) {
            summary.stoppedBy = reviewed.halt;
            break;
          }
          if (reviewed.verification.incomplete) {
            summary.errors++;
            deferred = true;
            break;
          }
          if (
            reviewed.verification.status === "accepted" &&
            reviewed.changeSet
          ) {
            stage = "apply";
            // A failed write may have committed before its acknowledgement was lost.
            for (const pageId of plan.targetPageIds) changed.add(pageId);
            const applied = await steps.apply(reviewed.changeSet);
            if (applied.status === "conflict") {
              summary.conflicts++;
              deferred = true;
              for (const pageId of applied.pageIds) changed.add(pageId);
              decision = { operationId: plan.id, status: "conflict" };
            } else {
              summary.writes += applied.pages.length;
              for (const pageId of plan.targetPageIds) changed.add(pageId);
              deferred = true;
              decision = {
                operationId: plan.id,
                status: "applied",
                changeSet: reviewed.changeSet,
                verification: reviewed.verification,
              };
            }
            break;
          }
          if (
            reviewed.verification.status === "rejected" &&
            attempt < options.repairs
          ) {
            stage = "draft";
            draft = await steps.draft(
              snapshot,
              plan,
              attempt + 1,
              reviewed.verification.defects,
            );
            continue;
          }
          if (reviewed.verification.status === "rejected") summary.rejected++;
          else summary.unresolved++;
          if (reviewed.verification.capacity) summary.capacityLimited++;
          decision = {
            operationId: plan.id,
            status:
              reviewed.verification.status === "rejected"
                ? "rejected"
                : "uncertain",
            verification: reviewed.verification,
            ...(reviewed.verification.capacity ? { reason: "capacity" } : {}),
          };
          break;
        }
        stage = "decision_record";
        if (decision)
          await steps.record(`decision:${plan.id}`, {
            ...decision,
            evidenceFingerprints: result.dependencies?.filter(
              (ref): ref is { pageId: string; fingerprint: string } =>
                ref.fingerprint !== null &&
                plan.readSet.some((read) => read.pageId === ref.pageId),
            ),
          });
        if (summary.stoppedBy === "budget" || summary.stoppedBy === "provider")
          break;
      }
      if (summary.stoppedBy === "budget" || summary.stoppedBy === "provider")
        break;
      if (!deferred) remaining.delete(id);
      consecutiveProviderErrors = 0;
    } catch (error) {
      summary.errors++;
      const diagnostic = failureDiagnostic(error);
      await steps.record(`task-error:${id}`, {
        taskId: id,
        pageIds: task.pageIds,
        status: "error",
        stage,
        ...(operationId ? { operationId } : {}),
        error: diagnostic,
      });
      consecutiveProviderErrors =
        diagnostic.category === "gateway" ? consecutiveProviderErrors + 1 : 0;
      if (consecutiveProviderErrors >= 3) {
        summary.stoppedBy = "provider";
        break;
      }
    } finally {
      // Keep invalidations even if recording the decision after a write fails.
      for (const [taskId, pageIds] of completedReads)
        if (pageIds.some((pageId) => changed.has(pageId)))
          remaining.add(taskId);
    }
  }
  summary.remainingTasks = scan.remaining + remaining.size;
  if (summary.stoppedBy === "stable" && summary.remainingTasks)
    summary.stoppedBy = summary.errors
      ? "incomplete"
      : changed.size
        ? "changed"
        : "limit";
  if (summary.remainingTasks || summary.errors || summary.capacityLimited)
    summary.status = "partial";
  await steps.queue(order.filter((id) => !remaining.has(id)));
  summary.report = `Consolidation: ${summary.writes} page writes, ${summary.evaluatedTasks} analysed tasks, ${summary.reusedTasks} reused, ${summary.remainingTasks} queued. ${summary.unresolved} unresolved findings, ${summary.errors} errors. Stopped: ${summary.stoppedBy}.`;
  return summary;
}
