// Workflow-safe stage order of one owner's night: type-only imports.
import type { WorkflowJobKind } from "./jobs";
import type { TaskPhaseScope } from "./task-phase";

export type NightlyOptions = {
  /** Only the scheduled nightly scope exists. */
  scope?: TaskPhaseScope;
  /** Whether the nightly scope includes the task phases: the owner's task
   * manager setting when the run was started, kept for the whole run. */
  tasks?: boolean;
};

export type StageOutcome = { status: string; [key: string]: unknown };
export type NightlyStages = Partial<Record<WorkflowJobKind, StageOutcome>>;

/** Consolidation, then embeddings → hygiene beside export. */
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
  const consolidation = await settle("consolidation");
  const [indexing, exported] = await Promise.all([
    settle("embeddings").then(async (embeddings) => ({
      embeddings,
      ...(options.tasks ? { task_keeper: await settle("task_keeper") } : {}),
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
