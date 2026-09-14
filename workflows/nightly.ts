import { createHook, getWorkflowMetadata, sleep } from "workflow";
import {
  appendConsolidationToolResults,
  CONSOLIDATION_LIMITS,
  type ConsolidationToolResult,
} from "@/lib/maintenance/consolidation";
import { EMBEDDING_LIMITS } from "@/lib/maintenance/embedding-batch";
import {
  beginJob,
  completeJob,
  consolidationRound,
  consolidationTool,
  embedBatch,
  nextEmbeddingBatch,
  pendingEmbeddingCount,
  prepareConsolidation,
  publishExport,
  storeEmbeddingBatch,
  takeExportSnapshot,
} from "@/lib/maintenance/steps";
import type { ReadReceipt } from "@/lib/maintenance/tools";

async function consolidate(ownerId: string) {
  let state = await prepareConsolidation(ownerId);
  const reads: Record<string, ReadReceipt> = {};
  while (!state.completed) {
    state = await consolidationRound(state);
    if (state.completed) break;
    const results: ConsolidationToolResult[] = [];
    let writes = state.writes;
    for (const call of state.pendingToolCalls) {
      const result = await consolidationTool(
        ownerId,
        call,
        reads,
        writes < CONSOLIDATION_LIMITS.writes,
      );
      if (result.writeSucceeded) writes++;
      if (result.read)
        for (const ref of result.read.refs) reads[ref] = result.read.receipt;
      results.push(result);
    }
    state = appendConsolidationToolResults(state, results);
  }
  return {
    writes: state.writes,
    rounds: state.rounds,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    report: state.report,
    budgetReached: state.budgetReached,
  };
}

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
  kind: "consolidation" | "embeddings" | "export",
  runDate: string,
  runId: string,
) {
  const job = await beginJob(ownerId, kind, runDate, runId);
  if (job.skip) return { id: job.id, status: job.status, skipped: true };
  try {
    if (kind === "consolidation") {
      const result = await consolidate(ownerId);
      return await completeJob(
        ownerId,
        job.id,
        runId,
        result.budgetReached ? "partial" : "succeeded",
        result,
      );
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
    const snapshot = await takeExportSnapshot(ownerId);
    const result = await publishExport(snapshot, runDate, job.id);
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

export async function nightlyMaintenance(ownerId: string, runDate: string) {
  "use workflow";
  // A durable owner lock serializes runs across dates as well as duplicate deliveries.
  // Waiting consumes no running function. Completed daily jobs are skipped below.
  while (true) {
    using lock = createHook({
      token: `brain-nightly:${ownerId}`,
      metadata: { runDate },
    });
    const conflict = await lock.getConflict();
    if (conflict) {
      await sleep("1 minute");
      continue;
    }
    const runId = getWorkflowMetadata().workflowRunId;
    const consolidation = await runPhase(
      ownerId,
      "consolidation",
      runDate,
      runId,
    ).catch(() => ({
      status: "failed",
      error: "Consolidation bookkeeping failed.",
    }));
    // A failed consolidation must never prevent deterministic indexing or export.
    const settled = await Promise.allSettled([
      runPhase(ownerId, "embeddings", runDate, runId),
      runPhase(ownerId, "export", runDate, runId),
    ]);
    const [embeddings, exported] = settled.map((result) =>
      result.status === "fulfilled"
        ? result.value
        : { status: "failed", error: "Maintenance bookkeeping failed." },
    );
    const jobs = { consolidation, embeddings, export: exported };
    if (Object.values(jobs).some((job) => job.status === "failed"))
      throw new Error(
        "Nightly maintenance finished with failed stages. See Operations for results and retry.",
      );
    return { runId, runDate, status: "completed", jobs };
  }
}
