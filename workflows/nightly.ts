import { createHook, getWorkflowMetadata, sleep } from "workflow";
import { EMBEDDING_LIMITS } from "@/lib/maintenance/embedding-batch";
import type { WorkflowJobKind } from "@/lib/maintenance/jobs";
import {
  type NightlyOptions,
  runNightlyStages,
} from "@/lib/maintenance/nightly-stages";
import {
  beginJob,
  completeJob,
  embedBatch,
  exportRepositoryForOwner,
  nextEmbeddingBatch,
  pendingEmbeddingCount,
  publishExport,
  storeEmbeddingBatch,
  takeExportSnapshot,
} from "@/lib/maintenance/steps";
import { runTaskKeeperPhase } from "@/lib/maintenance/task-keeper";
import { runTaskLinksPhase } from "@/lib/maintenance/task-links";
import type {
  TaskPhaseContext,
  TaskPhaseScope,
} from "@/lib/maintenance/task-phase";
import { consolidate } from "./consolidation";

async function indexPages(ownerId: string) {
  let indexedPages = 0;
  let inputTokens = 0;
  let embeddedChunks = 0;
  let conflicts = 0;
  let batches = 0;
  while (
    indexedPages < EMBEDDING_LIMITS.pages &&
    batches < EMBEDDING_LIMITS.batches &&
    conflicts < EMBEDDING_LIMITS.conflicts
  ) {
    const next = await nextEmbeddingBatch(
      ownerId,
      EMBEDDING_LIMITS.tokens - inputTokens,
    );
    if (next.complete || !next.batch) break;
    const embeddings = await embedBatch(next.batch);
    // Count paid work even if a concurrent page edit makes the version obsolete.
    inputTokens += next.batch.chunks.reduce(
      (sum, chunk) => sum + chunk.tokenCount,
      0,
    );
    embeddedChunks += embeddings.length;
    batches++;
    const result = await storeEmbeddingBatch(ownerId, next.batch, embeddings);
    if (result.conflict) conflicts++;
    else if (result.indexed) indexedPages++;
  }
  const remaining = await pendingEmbeddingCount(ownerId);
  return {
    indexedPages,
    embeddedChunks,
    inputTokens,
    batches,
    conflicts,
    remaining,
    budgetReached: remaining > 0,
  };
}

async function runPhase(
  ownerId: string,
  kind: WorkflowJobKind,
  runDate: string,
  runId: string,
  rerunFrom?: string,
  scope: TaskPhaseScope = "nightly",
) {
  const job = await beginJob(ownerId, kind, runDate, runId, rerunFrom);
  if (job.skip) return { id: job.id, status: job.status, skipped: true };
  try {
    if (kind === "consolidation") {
      const result = await consolidate(ownerId, runId);
      return await completeJob(ownerId, job.id, runId, result.status, result);
    }
    if (kind === "embeddings") {
      const result = await indexPages(ownerId);
      return await completeJob(
        ownerId,
        job.id,
        runId,
        result.remaining ? "partial" : "succeeded",
        result,
      );
    }
    if (kind === "task_keeper" || kind === "task_links") {
      const context: TaskPhaseContext = {
        ownerId,
        runId,
        runDate,
        jobId: job.id,
        attempts: job.attempts,
        scope,
      };
      const result =
        kind === "task_keeper"
          ? await runTaskKeeperPhase(context)
          : await runTaskLinksPhase(context);
      return await completeJob(
        ownerId,
        job.id,
        runId,
        result.status === "partial" ? "partial" : "succeeded",
        result,
      );
    }
    const repository = await exportRepositoryForOwner(ownerId);
    if (!repository)
      return await completeJob(ownerId, job.id, runId, "succeeded", {
        skipped: true,
      });
    const snapshot = await takeExportSnapshot(ownerId);
    const result = await publishExport(
      snapshot,
      runDate,
      job.id,
      job.attempts,
      repository,
    );
    return await completeJob(ownerId, job.id, runId, "succeeded", result);
  } catch (error) {
    return await completeJob(
      ownerId,
      job.id,
      runId,
      "failed",
      {},
      error instanceof Error
        ? error.message.slice(0, 2000)
        : "Maintenance phase failed.",
    );
  }
}

export async function nightlyMaintenance(
  ownerId: string,
  runDate: string,
  rerunConsolidationFrom?: string,
  options: NightlyOptions = {},
) {
  "use workflow";
  const scope = options.scope ?? "nightly";
  // A durable owner lock serializes runs across dates as well as duplicate deliveries.
  // Waiting consumes no running function. Completed daily jobs are skipped below.
  while (true) {
    using lock = createHook({
      token: `brain-nightly:${ownerId}`,
      metadata: { runDate, scope },
    });
    const conflict = await lock.getConflict();
    if (conflict) {
      await sleep("1 minute");
      continue;
    }
    const runId = getWorkflowMetadata().workflowRunId;
    // A failed consolidation must never prevent deterministic indexing or export.
    const { failed, jobs } = await runNightlyStages(
      (kind) =>
        runPhase(
          ownerId,
          kind,
          runDate,
          runId,
          kind === "consolidation" ? rerunConsolidationFrom : undefined,
          scope,
        ),
      { scope, tasks: options.tasks === true },
    );
    if (failed)
      throw new Error(
        "Nightly maintenance finished with failed stages. See Operations for results and retry.",
      );
    return { runId, runDate, status: "completed", jobs };
  }
}
