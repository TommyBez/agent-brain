import { runConsolidation } from "@/lib/maintenance/consolidator/runner";
import {
  analyzeConsolidationTask,
  applyConsolidation,
  draftConsolidation,
  finishConsolidation,
  initializeConsolidation,
  planConsolidation,
  prepareConsolidationScan,
  queueConsolidation,
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
      scan: (snapshotId, budget) =>
        prepareConsolidationScan(ownerId, runId, snapshotId, budget),
      analyze: (snapshotId, task) =>
        analyzeConsolidationTask(ownerId, runId, snapshotId, task),
      plan: (snapshotId, results) =>
        planConsolidation(ownerId, runId, snapshotId, results),
      draft: (snapshotId, plan, attempt, feedback) =>
        draftConsolidation(ownerId, runId, snapshotId, plan, attempt, feedback),
      review: (snapshotId, plan, draft) =>
        reviewConsolidation(ownerId, runId, snapshotId, plan, draft),
      queue: (taskIds) => queueConsolidation(ownerId, taskIds),
      apply: (changeSet) => applyConsolidation(ownerId, runId, changeSet),
      record: (key, value) => recordConsolidation(ownerId, runId, key, value),
    },
    options,
  );
  await finishConsolidation(ownerId, runId, result);
  return result;
}
