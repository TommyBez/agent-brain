import { z } from "zod";
import { embeddingSchema } from "@/lib/brain/schemas";

export const EMBEDDING_LIMITS = {
  pages: 100,
  tokens: 120_000,
  chunks: 24,
  batches: 1000,
  conflicts: 5,
} as const;
export type EmbeddingBatch = {
  id: string;
  version: number;
  embeddingModel: string;
  chunkerVersion: string;
  chunks: { contentHash: string; content: string; tokenCount: number }[];
};

/** A budget limits this pass, never the indexed extent of a page. */
export function affordableBatch(
  page: EmbeddingBatch,
  remainingTokens: number,
): EmbeddingBatch | null {
  let tokens = 0;
  const chunks = [];
  for (const chunk of page.chunks.slice(0, EMBEDDING_LIMITS.chunks)) {
    if (tokens + chunk.tokenCount > remainingTokens) break;
    chunks.push(chunk);
    tokens += chunk.tokenCount;
  }
  // No missing chunks means indexChunks can publish entirely reused vectors.
  if (page.chunks.length && !chunks.length) return null;
  return { ...page, chunks };
}

export function parseEmbeddingResponse(
  batch: EmbeddingBatch,
  response: unknown,
) {
  const { data } = z
    .object({
      data: z
        .array(
          z.object({
            index: z.number().int().nonnegative(),
            embedding: embeddingSchema,
          }),
        )
        .length(batch.chunks.length),
    })
    .parse(response);
  const byIndex = new Map(data.map((item) => [item.index, item.embedding]));
  if (
    byIndex.size !== batch.chunks.length ||
    data.some((item) => item.index >= batch.chunks.length)
  )
    throw new Error(
      "Embedding response indices do not match the requested batch.",
    );
  return batch.chunks.map((chunk, index) => {
    const embedding = byIndex.get(index);
    if (!embedding) throw new Error("Embedding response is incomplete.");
    return { contentHash: chunk.contentHash, embedding };
  });
}
