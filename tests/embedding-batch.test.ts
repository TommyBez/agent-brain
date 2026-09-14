import assert from "node:assert/strict";
import test from "node:test";
import {
  affordableBatch,
  type EmbeddingBatch,
  parseEmbeddingResponse,
} from "../lib/maintenance/embedding-batch";

const page: EmbeddingBatch = {
  id: "page",
  version: 7,
  embeddingModel: "openai/text-embedding-3-small",
  chunkerVersion: "test",
  chunks: Array.from({ length: 3 }, (_, i) => ({
    contentHash: `hash${i}`,
    content: `passage${i}`,
    tokenCount: 10,
  })),
};
const vector = (value: number) =>
  Array.from({ length: 1536 }, (_, i) => (i === 0 ? value : 0));

test("embedding budget saves affordable sections without changing version or truncating source", () => {
  const batch = affordableBatch(page, 25);
  assert.deepEqual(batch?.chunks, page.chunks.slice(0, 2));
  assert.equal(batch?.version, 7);
  assert.equal(page.chunks.length, 3);
  assert.equal(affordableBatch(page, 9), null);
  assert.deepEqual(affordableBatch({ ...page, chunks: [] }, 0)?.chunks, []);
});

test("embedding response maps reordered vectors to content hashes", () => {
  const embeddings = parseEmbeddingResponse(page, {
    data: [2, 0, 1].map((index) => ({ index, embedding: vector(index + 1) })),
  });
  assert.deepEqual(
    embeddings.map((item) => [item.contentHash, item.embedding[0]]),
    [
      ["hash0", 1],
      ["hash1", 2],
      ["hash2", 3],
    ],
  );
});

test("malformed provider batches cannot publish a mismatched index", () => {
  const valid = [0, 1, 2].map((index) => ({
    index,
    embedding: vector(index + 1),
  }));
  for (const data of [
    valid.slice(1),
    [valid[0], valid[0], valid[2]],
    [...valid.slice(0, 2), { ...valid[2], index: 9 }],
    [{ ...valid[0], embedding: [1] }, ...valid.slice(1)],
    [{ ...valid[0], embedding: vector(0) }, ...valid.slice(1)],
  ])
    assert.throws(() => parseEmbeddingResponse(page, { data }));
});
