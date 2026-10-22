import type { TaskPhaseContext, TaskPhaseResult } from "../task-phase";
import {
  embedTaskVectorsStep,
  finishTaskLinksStep,
  linkTaskBatchStep,
  planTaskLinksStep,
  refreshDeterministicLinksStep,
} from "./steps";

/** Job result of the `task_links` phase (§8.1–8.3, release criterion 7). */
export type TaskLinksResult = TaskPhaseResult & {
  tasksConsidered: number;
  unitsReused: number;
  suggested: number;
  retracted: number;
  /**
   * Tasks left for the next run: changed ones beyond `maxTasksPerRun`, which
   * lead the next queue, plus any a halt did not reach.
   */
  remainingTasks: number;
};

const VECTOR_BATCH = 32;
const DETERMINISTIC_BATCH = 25;
const JEV_BATCH = 8;

function batches<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    chunks.push(items.slice(index, index + size));
  return chunks;
}

/** Nightly `task_links` phase, after embeddings and task_keeper.
 *
 * Runs at Workflow level inside nightlyMaintenance's owner lock, like
 * `consolidate`: do I/O only in "use step" functions. Charge Jev through
 * `evaluatePersisted(…, budgetedGateway(ownerId, runId, "task_links"))` and
 * return `partial` with a halt, never throw, when the budget, Jev or task
 * embeddings stop the pass. Never write pages, brain_links or revisions.
 *
 * Order: task vectors for changed tasks; rules and retrieval for every open
 * task (rules never depend on vectors, retrieval uses those available); one
 * Jev request per changed LinkUnit, at most 200 tasks, changed ones first.
 */
export async function runTaskLinksPhase(
  context: TaskPhaseContext,
): Promise<TaskLinksResult> {
  const { ownerId, runId } = context;
  const plan = await planTaskLinksStep(ownerId);
  let halt: TaskLinksResult["halt"] = null;
  let vectorsEmbedded = 0;
  for (const taskIds of batches(plan.vectorTaskIds, VECTOR_BATCH)) {
    const embedded = await embedTaskVectorsStep(ownerId, taskIds);
    vectorsEmbedded += embedded.embedded;
    if (embedded.halt) {
      halt = embedded.halt;
      break;
    }
  }
  const rules = { suggested: 0, activated: 0, retracted: 0 };
  const retrieval = { searched: 0, suggested: 0, retracted: 0 };
  for (const taskIds of batches(plan.openTaskIds, DETERMINISTIC_BATCH)) {
    const refreshed = await refreshDeterministicLinksStep(
      ownerId,
      runId,
      taskIds,
      plan.corpus,
    );
    rules.suggested += refreshed.rules.suggested;
    rules.activated += refreshed.rules.activated;
    rules.retracted += refreshed.rules.retracted;
    retrieval.searched += refreshed.retrieval.searched;
    retrieval.suggested += refreshed.retrieval.suggested;
    retrieval.retracted += refreshed.retrieval.retracted;
  }
  const jev = {
    tasksConsidered: 0,
    unitsReused: 0,
    requests: 0,
    suggested: 0,
    activated: 0,
    retracted: 0,
    deferred: 0,
  };
  let remainingTasks = plan.remainingTasks;
  const jevBatches = batches(plan.jevTaskIds, JEV_BATCH);
  for (const [index, taskIds] of jevBatches.entries()) {
    const linked = await linkTaskBatchStep(
      ownerId,
      runId,
      taskIds,
      plan.autoApply,
      plan.corpus,
    );
    jev.tasksConsidered += linked.tasksConsidered;
    jev.unitsReused += linked.unitsReused;
    jev.requests += linked.requests;
    jev.suggested += linked.suggested;
    jev.activated += linked.activated;
    jev.retracted += linked.retracted;
    jev.deferred += linked.deferred;
    if (linked.halt) {
      halt = linked.halt;
      remainingTasks +=
        linked.unprocessed +
        jevBatches
          .slice(index + 1)
          .reduce((total, batch) => total + batch.length, 0);
      break;
    }
  }
  const finished = await finishTaskLinksStep(ownerId, runId);
  return {
    status: halt ? "partial" : "succeeded",
    halt,
    tasksConsidered: jev.tasksConsidered,
    unitsReused: jev.unitsReused,
    requests: jev.requests,
    suggested: rules.suggested + retrieval.suggested + jev.suggested,
    retracted: rules.retracted + retrieval.retracted + jev.retracted,
    remainingTasks,
    spendNano: finished.spendNano,
    vectorsEmbedded,
    rules,
    retrieval,
    jev,
    autoApply: plan.autoApply,
    autoApplyBlockedBy: plan.autoApplyReasons,
    ...finished.hygiene,
  };
}
