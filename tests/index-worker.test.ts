import assert from "node:assert/strict";
import test from "node:test";
import { indexPendingChunks } from "../scripts/index-embeddings.mjs";

const vector = (value: number) =>
  Array.from({ length: 1536 }, (_, index) => (index === 0 ? value : 0));
type Call = { name: string; arguments: Record<string, unknown> };
const unpack = (value: unknown) => value;

test("worker streams all chunks, associates reordered provider results, and resumes persisted batches", async () => {
  const persisted = new Set<string>();
  let complete = false;
  let fail = true;
  const seenInputs: string[] = [];
  const all = Array.from({ length: 55 }, (_, index) => ({
    contentHash: `hash-${index}`,
    content: `source-${index}`,
    tokenCount: 10,
    needsEmbedding: true,
  }));
  const callTool = async ({ name, arguments: args }: Call) => {
    if (name === "pending_embeddings") {
      assert.equal(args.chunkLimit, 24);
      return complete
        ? []
        : [
            {
              id: "page",
              version: 2,
              embeddingModel: "test/model",
              chunkerVersion: "test/v1",
              chunks: all
                .filter((chunk) => !persisted.has(chunk.contentHash))
                .slice(0, 24),
            },
          ];
    }
    assert.equal(name, "index_chunks");
    const embeddings = args.embeddings as {
      contentHash: string;
      embedding: number[];
    }[];
    assert.ok(embeddings.length <= 24);
    for (const item of embeddings) {
      const ordinal = Number(item.contentHash.split("-")[1]);
      assert.equal(item.embedding[0], ordinal + 1);
      persisted.add(item.contentHash);
    }
    complete = persisted.size === all.length;
    return { indexed: complete, pendingChunks: all.length - persisted.size };
  };
  const gateway = async (_path: string, body: { input: string[] }) => {
    if (persisted.size === 24 && fail) throw new Error("provider unavailable");
    seenInputs.push(...body.input);
    return {
      data: body.input
        .map((input, index) => ({
          index,
          embedding: vector(Number(input.split("-")[1]) + 1),
        }))
        .reverse(),
    };
  };
  await assert.rejects(
    indexPendingChunks({ callTool, gateway, unpack }),
    /provider unavailable/,
  );
  assert.equal(persisted.size, 24);
  fail = false;
  const result = await indexPendingChunks({ callTool, gateway, unpack });
  assert.equal(result.indexed, 1);
  assert.equal(result.embeddedChunks, 31);
  assert.equal(complete, true);
  assert.equal(seenInputs.length, 55);
  assert.equal(new Set(seenInputs).size, 55);
});

test("worker token budget commits affordable chunks without declaring the page complete", async () => {
  let stored = false;
  const result = await indexPendingChunks({
    maxTokens: 15,
    unpack,
    callTool: async ({ name, arguments: args }: Call) => {
      if (name === "index_chunks") {
        assert.equal((args.embeddings as unknown[]).length, 1);
        stored = true;
        return { indexed: false };
      }
      return [
        {
          id: "page",
          version: 1,
          embeddingModel: "test/model",
          chunkerVersion: "v1",
          chunks: (stored ? ["second"] : ["first", "second"]).map(
            (contentHash) => ({
              contentHash,
              content: contentHash,
              tokenCount: 10,
              needsEmbedding: true,
            }),
          ),
        },
      ];
    },
    gateway: async () => ({ data: [{ index: 0, embedding: vector(1) }] }),
  });
  assert.equal(stored, true);
  assert.equal(result.indexed, 0);
  assert.equal(result.embeddedChunks, 1);
  assert.equal(result.budgetReached, true);
});

test("worker finalizes reused chunks without invoking the model", async () => {
  let complete = false;
  const result = await indexPendingChunks({
    unpack,
    callTool: async ({ name, arguments: args }: Call) => {
      if (name === "pending_embeddings")
        return complete
          ? []
          : [
              {
                id: "page",
                version: 2,
                embeddingModel: "test/model",
                chunkerVersion: "v1",
                chunks: [],
              },
            ];
      assert.deepEqual(args.embeddings, []);
      complete = true;
      return { indexed: true };
    },
    gateway: async () => {
      throw new Error("Must reuse cached vectors");
    },
  });
  assert.equal(result.indexed, 1);
  assert.equal(result.embeddedChunks, 0);
});

test("worker rejects incomplete vector batches before any database submission", async () => {
  await assert.rejects(
    indexPendingChunks({
      unpack,
      callTool: async ({ name }: Call) => {
        assert.equal(name, "pending_embeddings");
        return [
          {
            id: "page",
            version: 1,
            embeddingModel: "test/model",
            chunkerVersion: "v1",
            chunks: [
              {
                contentHash: "a",
                content: "a",
                tokenCount: 1,
                needsEmbedding: true,
              },
            ],
          },
        ];
      },
      gateway: async () => ({ data: [] }),
    }),
    /incomplete chunk embeddings/,
  );
});
