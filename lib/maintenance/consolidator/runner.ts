import { attempt } from "./attempt";
import { failureDiagnostic } from "./diagnostics";

import { recordKeys } from "./keys";
import type {
  AnalysisResult,
  AnalysisTask,
  PlannedTask,
  RunHalt,
  RunnerSteps,
} from "./types";
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
/** One immutable snapshot. Finish each intervention before spending on overlapping tasks. */
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
  const scan = await steps.scan(snapshot.id, options.taskBudget);
  summary.totalTasks = scan.total;
  summary.reusedTasks = scan.reused;
  const cached = new Map(scan.cached.map((result) => [result.taskId, result]));
  const changed = new Set<string>();
  const completed: { id: string; reads: string[] }[] = [];
  let consecutiveProviderErrors = 0;
  for (const task of scan.tasks) {
    const prior = cached.get(task.id);
    if (
      (prior?.dependencies?.map((ref) => ref.pageId) ?? task.pageIds).some(
        (id) => changed.has(id),
      )
    )
      continue;
    const outcome = await processTask(
      steps,
      snapshot.id,
      task,
      prior,
      scan.plans?.[task.id],
      changed,
      options.repairs,
    );
    for (const id of outcome.changed) changed.add(id);
    summary.evaluatedTasks += outcome.evaluated;
    summary.findings += outcome.findings;
    summary.unresolved += outcome.unresolved;
    summary.proposed += outcome.proposed;
    summary.rejected += outcome.rejected;
    summary.conflicts += outcome.conflicts;
    summary.errors += outcome.errors;
    summary.capacityLimited += outcome.capacity;
    summary.writes += outcome.writes;
    if (outcome.complete) completed.push({ id: task.id, reads: outcome.reads });
    consecutiveProviderErrors = outcome.gatewayFailure
      ? consecutiveProviderErrors + 1
      : 0;
    if (outcome.halt || consecutiveProviderErrors >= 3) {
      summary.stoppedBy = outcome.halt ?? "provider";
      break;
    }
  }
  // One terminal invalidation pass, including writes whose acknowledgement or decision record failed.
  const completedIds = completed
    .filter((task) => !task.reads.some((id) => changed.has(id)))
    .map((task) => task.id);
  summary.remainingTasks =
    scan.remaining + scan.tasks.length - completedIds.length;
  if (summary.stoppedBy === "stable" && summary.remainingTasks)
    summary.stoppedBy = summary.errors
      ? "incomplete"
      : changed.size
        ? "changed"
        : "limit";
  if (summary.remainingTasks || summary.errors || summary.capacityLimited)
    summary.status = "partial";
  await steps.queue(completedIds);
  summary.report = `Consolidation: ${summary.writes} page writes, ${summary.evaluatedTasks} analysed tasks, ${summary.reusedTasks} reused, ${summary.remainingTasks} queued. ${summary.unresolved} unresolved findings, ${summary.errors} errors. Stopped: ${summary.stoppedBy}.`;
  return summary;
}

type TaskOutcome = {
  evaluated: number;
  findings: number;
  unresolved: number;
  proposed: number;
  rejected: number;
  conflicts: number;
  errors: number;
  capacity: number;
  writes: number;
  changed: string[];
  reads: string[];
  complete: boolean;
  gatewayFailure: boolean;
  halt?: RunHalt["halt"];
};
async function processTask(
  steps: RunnerSteps,
  snapshotId: string,
  task: AnalysisTask,
  cached: AnalysisResult | undefined,
  prepared: PlannedTask | undefined,
  changed: ReadonlySet<string>,
  repairs: number,
): Promise<TaskOutcome> {
  const outcome: TaskOutcome = {
    evaluated: 0,
    findings: 0,
    unresolved: 0,
    proposed: 0,
    rejected: 0,
    conflicts: 0,
    errors: 0,
    capacity: 0,
    writes: 0,
    changed: [],
    reads: task.pageIds,
    complete: false,
    gatewayFailure: false,
  };
  let stage = "analysis";
  let operationId: string | undefined;
  const fail = async (
    diagnostic: ReturnType<typeof failureDiagnostic>,
    failureStage: string,
  ) => {
    outcome.gatewayFailure = diagnostic.category === "gateway";
    await steps.record(recordKeys.taskError(task.id), {
      taskId: task.id,
      pageIds: task.pageIds,
      status: "error",
      stage: failureStage,
      ...(operationId ? { operationId } : {}),
      error: diagnostic,
    });
    return outcome;
  };
  try {
    const result = cached ?? (await steps.analyze(snapshotId, task));
    if ("halt" in result) return { ...outcome, halt: result.halt };
    if (!cached) outcome.evaluated++;
    outcome.reads =
      result.dependencies?.map((ref) => ref.pageId) ?? task.pageIds;
    outcome.findings = result.findings.length;
    outcome.unresolved = result.findings.filter(
      (finding) => finding.status === "uncertain",
    ).length;
    if (result.status === "incomplete") return { ...outcome, errors: 1 };
    if (outcome.reads.some((id) => changed.has(id))) return outcome;
    if (!result.findings.some((finding) => finding.status === "supported"))
      return { ...outcome, complete: true };
    stage = "planning";
    const plans = prepared ?? (await steps.plan(snapshotId, [result]));
    outcome.capacity += plans.capacityLimited ?? 0;
    let deferred = plans.deferred > 0;
    for (const plan of plans.selected) {
      if (
        plan.readSet.some(
          (ref) =>
            changed.has(ref.pageId) || outcome.changed.includes(ref.pageId),
        )
      ) {
        deferred = true;
        continue;
      }
      operationId = plan.id;
      outcome.proposed++;
      let feedback: string[] | undefined;
      for (let index = 0; index <= repairs; index++) {
        const tried = await attempt(
          steps,
          snapshotId,
          plan,
          index,
          repairs,
          feedback,
        );
        outcome.changed.push(...tried.changed);
        outcome.writes += tried.writes;
        outcome.errors += tried.errors;
        outcome.capacity += tried.capacity;
        deferred ||= tried.deferred;
        if (tried.halt) return { ...outcome, halt: tried.halt };
        if (tried.failure)
          return fail(tried.failure.diagnostic, tried.failure.stage);
        if (tried.repair) {
          feedback = tried.repair;
          continue;
        }
        const decision = tried.decision;
        if (decision) {
          if (decision.status === "rejected") outcome.rejected++;
          if (decision.status === "conflict") outcome.conflicts++;
          if (decision.status === "uncertain" && decision.verification)
            outcome.unresolved++;
          stage = "decision_record";
          await steps.record(recordKeys.decision(plan.id), {
            ...decision,
            evidenceFingerprints: result.dependencies?.filter(
              (ref): ref is { pageId: string; fingerprint: string } =>
                ref.fingerprint !== null &&
                plan.readSet.some((read) => read.pageId === ref.pageId),
            ),
          });
        }
        break;
      }
    }
    outcome.complete = !deferred;
    return outcome;
  } catch (error) {
    outcome.errors++;
    return fail(failureDiagnostic(error), stage);
  }
}
