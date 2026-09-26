import { FatalError, RetryableError } from "workflow";
import * as brain from "@/lib/brain/service";
import { BrainError } from "@/lib/brain/types";
import { exportBrain } from "@/lib/operations";
import { revalidateWorkspaceCache } from "@/lib/workspace/cache";
import {
  affordableBatch,
  EMBEDDING_LIMITS,
  type EmbeddingBatch,
  parseEmbeddingResponse,
} from "./embedding-batch";
import { GatewayRequestError, gatewayRequest } from "./gateway";
import {
  type BrainExportSnapshot,
  exportBrainToGitHub,
  GitHubExportError,
} from "./github-export";
import {
  beginWorkflowJob,
  finishWorkflowJob,
  type WorkflowJobKind,
  workflowExportAttemptKey,
} from "./jobs";

function providerError(error: unknown): never {
  if (error instanceof GatewayRequestError) {
    if (!error.retryable) throw new FatalError(error.message);
    throw new RetryableError(error.message, {
      retryAfter: error.retryAfterMs ?? 30_000,
    });
  }
  throw error;
}

export async function beginJob(
  ownerId: string,
  kind: WorkflowJobKind,
  runDate: string,
  runId: string,
) {
  "use step";
  return beginWorkflowJob(ownerId, kind, runDate, runId);
}

export async function completeJob(
  ownerId: string,
  id: string,
  runId: string,
  status: "succeeded" | "partial" | "failed",
  result: Record<string, unknown>,
  error?: string,
) {
  "use step";
  await finishWorkflowJob(ownerId, id, runId, status, result, error);
  return { id, status, result, ...(error ? { error } : {}) };
}

export async function nextEmbeddingBatch(
  ownerId: string,
  remainingTokens: number,
) {
  "use step";
  const [page] = await brain.listPendingEmbeddings(
    ownerId,
    1,
    EMBEDDING_LIMITS.chunks,
  );
  if (!page) return { complete: true as const, batch: null };
  return {
    complete: false as const,
    batch: affordableBatch(page, remainingTokens),
  };
}

export async function embedBatch(batch: EmbeddingBatch) {
  "use step";
  if (!batch.chunks.length) return [];
  let response: unknown;
  try {
    response = await gatewayRequest("embeddings", {
      model: batch.embeddingModel,
      input: batch.chunks.map((chunk) => chunk.content),
      dimensions: 1536,
    });
  } catch (error) {
    return providerError(error);
  }
  try {
    return parseEmbeddingResponse(batch, response);
  } catch {
    throw new RetryableError(
      "AI Gateway returned an invalid embedding batch.",
      { retryAfter: 30_000 },
    );
  }
}

export async function storeEmbeddingBatch(
  ownerId: string,
  batch: EmbeddingBatch,
  embeddings: { contentHash: string; embedding: number[] }[],
) {
  "use step";
  try {
    const result = await brain.indexChunks(ownerId, {
      ref: batch.id,
      expectedVersion: batch.version,
      embeddingModel: batch.embeddingModel,
      chunkerVersion: batch.chunkerVersion,
      embeddings,
    });
    revalidateWorkspaceCache(ownerId);
    return { conflict: false as const, ...result };
  } catch (error) {
    if (error instanceof BrainError && error.code === "VERSION_CONFLICT")
      return { conflict: true as const, indexed: false };
    throw error;
  }
}

export async function pendingEmbeddingCount(ownerId: string) {
  "use step";
  const stats = await brain.getStats(ownerId);
  return stats.pages - stats.embeddedPages;
}

export async function takeExportSnapshot(ownerId: string) {
  "use step";
  return exportBrain(ownerId) as Promise<BrainExportSnapshot>;
}

export async function publishExport(
  snapshot: BrainExportSnapshot,
  runDate: string,
  jobId: string,
  attempts = 1,
) {
  "use step";
  if (!process.env.BRAIN_EXPORT_GITHUB_TOKEN)
    throw new FatalError(
      "BRAIN_EXPORT_GITHUB_TOKEN is required for Git export.",
    );
  try {
    return await exportBrainToGitHub({
      snapshot,
      runDate,
      jobId: workflowExportAttemptKey(jobId, attempts),
      signal: AbortSignal.timeout(240_000),
    });
  } catch (error) {
    if (
      error instanceof GitHubExportError &&
      error.retryable !== true &&
      error.status &&
      error.status >= 400 &&
      error.status < 500 &&
      ![408, 409, 422, 429].includes(error.status)
    )
      throw new FatalError(error.message);
    throw new RetryableError(
      error instanceof GitHubExportError
        ? error.message
        : "Git export could not complete.",
      {
        retryAfter:
          error instanceof GitHubExportError
            ? (error.retryAfterMs ?? 30_000)
            : 30_000,
      },
    );
  }
}
