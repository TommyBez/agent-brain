// Workflow-safe stage order of one owner's night: type-only imports.
import type { WorkflowJobKind } from "./jobs";
import type { TaskPhaseScope } from "./task-phase";

export type NightlyOptions = {
  /** `tasks` runs only task_keeper and task_links (Operations "Run now"). */
  scope?: TaskPhaseScope;
  /** Whether the nightly scope includes the task phases: the owner's task
   * manager setting when the run was started, kept for the whole run. */
  tasks?: boolean;
};

export type StageOutcome = { status: string; [key: string]: unknown };
export type NightlyStages = Partial<Record<WorkflowJobKind, StageOutcome>>;

/** Pages first, then `allSettled([embeddings → task_keeper → task_links, export])`
 * (§8.2). Every stage runs even when an earlier one failed. A failed task phase
 * is reported in Operations but never fails the night.
 */
export async function runNightlyStages(
  run: (kind: WorkflowJobKind) => Promise<StageOutcome>,
  options: NightlyOptions = {},
): Promise<{ failed: boolean; jobs: NightlyStages }> {
  const settle = (kind: WorkflowJobKind): Promise<StageOutcome> =>
    run(kind).catch(() => ({
      status: "failed",
      error:
        kind === "consolidation"
          ? "Consolidation bookkeeping failed."
          : "Maintenance bookkeeping failed.",
    }));
  const taskPhases = async () => {
    const taskKeeper = await settle("task_keeper");
    return { task_keeper: taskKeeper, task_links: await settle("task_links") };
  };
  if (options.scope === "tasks")
    return { failed: false, jobs: await taskPhases() };
  const consolidation = await settle("consolidation");
  const [indexing, exported] = await Promise.all([
    settle("embeddings").then(async (embeddings) => ({
      embeddings,
      ...(options.tasks ? await taskPhases() : {}),
    })),
    settle("export"),
  ]);
  return {
    failed: [consolidation, indexing.embeddings, exported].some(
      (job) => job.status === "failed",
    ),
    jobs: { consolidation, ...indexing, export: exported },
  };
}
