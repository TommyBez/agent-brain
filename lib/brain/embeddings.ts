import { createHash } from "node:crypto";
import { EMBEDDING_DIMENSIONS, embeddingSchema } from "./schemas";
import { assertOwner, embeddingModel } from "./utils";

type QueryEmbedding = { embedding: number[]; embeddingModel: string };
const CACHE_TTL_MS = 15 * 60_000;
const CACHE_LIMIT = 256;
const MAX_IN_FLIGHT = 8;
const REQUEST_TIMEOUT_MS = 3500;
const cache = new Map<string, { value: QueryEmbedding; expiresAt: number }>();
const pending = new Map<string, Promise<QueryEmbedding | null>>();

export function queryEmbeddingsConfigured(): boolean {
  return (
    process.env.BRAIN_QUERY_EMBEDDINGS !== "false" &&
    Boolean(process.env.BRAIN_EMBEDDING_API_KEY)
  );
}

async function requestEmbedding(
  query: string,
  model: string,
): Promise<QueryEmbedding | null> {
  try {
    const response = await fetch("https://ai-gateway.vercel.sh/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.BRAIN_EMBEDDING_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: query,
        dimensions: EMBEDDING_DIMENSIONS,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const parsed = embeddingSchema.safeParse(payload?.data?.[0]?.embedding);
    if (!parsed.success) return null;
    return { embedding: parsed.data, embeddingModel: model };
  } catch {
    // Provider errors must not block retrieval or expose queries/credentials.
    return null;
  }
}

/** Server-only, bounded query inference; documents stay in the indexing worker. */
export async function getQueryEmbedding(
  ownerId: string,
  query: string,
): Promise<QueryEmbedding | null> {
  assertOwner(ownerId);
  if (!queryEmbeddingsConfigured()) return null;
  const text = query.trim();
  if (!text || text.length > 1000) return null;
  const model = embeddingModel();
  // No plaintext query is retained as a cache key. Scope reuse to the owner and
  // embedding space; model changes never reuse a vector from an older model.
  const key = createHash("sha256")
    .update(JSON.stringify([ownerId, model, EMBEDDING_DIMENSIONS, text]))
    .digest("hex");
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    cache.delete(key);
    cache.set(key, cached);
    return { ...cached.value, embedding: [...cached.value.embedding] };
  }
  cache.delete(key);
  let request = pending.get(key);
  if (!request) {
    if (pending.size >= MAX_IN_FLIGHT) return null;
    request = requestEmbedding(text, model)
      .then((value) => {
        if (value) {
          cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
          while (cache.size > CACHE_LIMIT) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
          }
        }
        return value;
      })
      .finally(() => pending.delete(key));
    pending.set(key, request);
  }
  const value = await request;
  return value ? { ...value, embedding: [...value.embedding] } : null;
}
