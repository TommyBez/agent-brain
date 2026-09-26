import { runConsolidation } from "@/lib/maintenance/consolidator/runner";
import {
  analyzeConsolidationTask,
  applyConsolidation,
  draftConsolidation,
  expandConsolidation,
  finishConsolidation,
  initializeConsolidation,
  planConsolidation,
  prepareConsolidationScan,
  recordConsolidation,
  reviewConsolidation,
  snapshotConsolidation,
} from "@/lib/maintenance/consolidator/steps";

/** Called inside nightlyMaintenance's durable owner lock. */
export async function consolidate(ownerId: string, runId: string) {
  const options = await initializeConsolidation(ownerId, runId);
  const result = await runConsolidation(
    {
      snapshot: () => snapshotConsolidation(ownerId, runId),
      scan: (snapshot, budget) =>
        prepareConsolidationScan(ownerId, runId, snapshot.id, budget),
      analyze: (snapshot, task) =>
        analyzeConsolidationTask(ownerId, runId, snapshot.id, task),
      plan: (snapshot, results) =>
        planConsolidation(ownerId, runId, snapshot.id, results),
      draft: (snapshot, plan, attempt, feedback) =>
        draftConsolidation(
          ownerId,
          runId,
          snapshot.id,
          plan,
          attempt,
          feedback,
        ),
      review: (snapshot, plan, draft) =>
        reviewConsolidation(ownerId, runId, snapshot.id, plan, draft),
      expand: (snapshot, plan, depth) =>
        expandConsolidation(ownerId, runId, snapshot.id, plan, depth),
      apply: (changeSet) => applyConsolidation(ownerId, runId, changeSet),
      record: (key, value) => recordConsolidation(ownerId, runId, key, value),
    },
    options,
  );
  await finishConsolidation(ownerId, runId, result);
  return result;
}
