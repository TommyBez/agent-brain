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
export type NightlyStageKind = WorkflowJobKind | "retention";
export type NightlyStages = Partial<Record<NightlyStageKind, StageOutcome>>;

/** Retention, consolidation, then embeddings → hygiene beside export. */
export async function runNightlyStages(
  run: (kind: NightlyStageKind) => Promise<StageOutcome>,
  options: NightlyOptions = {},
): Promise<{ failed: boolean; jobs: NightlyStages }> {
  const settle = (kind: NightlyStageKind): Promise<StageOutcome> =>
    run(kind).catch((error) => {
      console.error("nightly.stage_failed", { kind, error });
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    });
  const retention = await settle("retention");
  const consolidation = await settle("consolidation");
  const [indexing, exported] = await Promise.all([
    settle("embeddings").then(async (embeddings) => ({
      embeddings,
      ...(options.tasks ? { task_keeper: await settle("task_keeper") } : {}),
    })),
    settle("export"),
  ]);
  return {
    failed: [retention, consolidation, indexing.embeddings, exported].some(
      (job) => job.status === "failed",
    ),
    jobs: { retention, consolidation, ...indexing, export: exported },
  };
}
