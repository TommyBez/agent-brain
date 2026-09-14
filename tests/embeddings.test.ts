import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { getQueryEmbedding } from "../lib/brain/embeddings";
import { EMBEDDING_DIMENSIONS } from "../lib/brain/schemas";

test("query embeddings are scoped, cached and coalesced without sharing mutable vectors", async (t) => {
  const previousKey = process.env.BRAIN_EMBEDDING_API_KEY;
  const previousEnabled = process.env.BRAIN_QUERY_EMBEDDINGS;
  const previousModel = process.env.EMBEDDING_MODEL;
  t.after(() => {
    if (previousKey === undefined) delete process.env.BRAIN_EMBEDDING_API_KEY;
    else process.env.BRAIN_EMBEDDING_API_KEY = previousKey;
    if (previousEnabled === undefined)
      delete process.env.BRAIN_QUERY_EMBEDDINGS;
    else process.env.BRAIN_QUERY_EMBEDDINGS = previousEnabled;
    if (previousModel === undefined) delete process.env.EMBEDDING_MODEL;
    else process.env.EMBEDDING_MODEL = previousModel;
  });
  process.env.BRAIN_EMBEDDING_API_KEY = "test-only-key";
  process.env.BRAIN_QUERY_EMBEDDINGS = "true";
  process.env.EMBEDDING_MODEL = "openai/text-embedding-3-small";
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) =>
    i === 0 ? 1 : 0,
  );
  let calls = 0;
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, options?: RequestInit) => {
      calls++;
      assert.equal(url, "https://ai-gateway.vercel.sh/v1/embeddings");
      assert.ok(options);
      assert.equal(options.cache, "no-store");
      assert.ok(options.signal instanceof AbortSignal);
      const body = JSON.parse(options.body as string);
      assert.equal(body.dimensions, EMBEDDING_DIMENSIONS);
      return Response.json({ data: [{ embedding: vector }] });
    },
  );
  const owner = randomUUID();
  const query = "How do project decisions relate?";
  const [first, concurrent] = await Promise.all([
    getQueryEmbedding(owner, query),
    getQueryEmbedding(owner, query),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(first, concurrent);
  assert.ok(first);
  first.embedding[0] = 42;
  const cached = await getQueryEmbedding(owner, query);
  assert.equal(cached?.embedding[0], 1);
  assert.equal(calls, 1);
  await getQueryEmbedding(randomUUID(), query);
  assert.equal(calls, 2);
  process.env.EMBEDDING_MODEL = "test/different-embedding-space";
  await getQueryEmbedding(owner, query);
  assert.equal(calls, 3);

  process.env.BRAIN_QUERY_EMBEDDINGS = "false";
  assert.equal(await getQueryEmbedding(owner, query), null);
  process.env.BRAIN_QUERY_EMBEDDINGS = "true";
  delete process.env.BRAIN_EMBEDDING_API_KEY;
  assert.equal(await getQueryEmbedding(owner, query), null);
  assert.equal(calls, 3);
  await assert.rejects(getQueryEmbedding("", query), /authenticated owner/);
  fetchMock.mock.restore();
});

test("invalid vectors and gateway failures fall back without caching failures", async (t) => {
  const previousKey = process.env.BRAIN_EMBEDDING_API_KEY;
  const previousEnabled = process.env.BRAIN_QUERY_EMBEDDINGS;
  process.env.BRAIN_EMBEDDING_API_KEY = "test-only-key";
  process.env.BRAIN_QUERY_EMBEDDINGS = "true";
  t.after(() => {
    if (previousKey === undefined) delete process.env.BRAIN_EMBEDDING_API_KEY;
    else process.env.BRAIN_EMBEDDING_API_KEY = previousKey;
    if (previousEnabled === undefined)
      delete process.env.BRAIN_QUERY_EMBEDDINGS;
    else process.env.BRAIN_QUERY_EMBEDDINGS = previousEnabled;
  });
  const responses = [
    () => new Response("private provider failure", { status: 429 }),
    () => Response.json({ data: [{ embedding: [1, 2] }] }),
    () => Response.json({ data: [{ embedding: Array(1536).fill(0) }] }),
    () => {
      throw new DOMException("request timed out", "TimeoutError");
    },
    () => Response.json({ data: [{ embedding: Array(1536).fill(0.1) }] }),
  ];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => responses[calls++]());
  const owner = randomUUID();
  for (let attempt = 0; attempt < 4; attempt++) {
    assert.equal(await getQueryEmbedding(owner, "retry this query"), null);
  }
  assert.ok(await getQueryEmbedding(owner, "retry this query"));
  assert.equal(calls, 5);
  assert.equal(await getQueryEmbedding(owner, " "), null);
  assert.equal(await getQueryEmbedding(owner, "x".repeat(1001)), null);
  assert.equal(calls, 5);
});
