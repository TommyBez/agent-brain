import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { context, search, write } from "../lib/brain/service";
import { BrainError } from "../lib/brain/types";
import { embeddingModel } from "../lib/brain/utils";
import { getPool } from "../lib/db";
import { indexPageFixture } from "./helpers/brain-embeddings";

test(
  "automatic query embeddings, explicit vector bypass and truthful fallback",
  { skip: process.env.RUN_DB_TESTS !== "1" },
  async (t) => {
    const owner = `query-embedding-test-${randomUUID()}`;
    const outsider = `query-embedding-test-${randomUUID()}`;
    const vector = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));
    const otherVector = Array.from({ length: 1536 }, (_, i) =>
      i === 1 ? 1 : 0,
    );
    const originalKey = process.env.BRAIN_EMBEDDING_API_KEY;
    const originalEnabled = process.env.BRAIN_QUERY_EMBEDDINGS;
    const originalFetch = globalThis.fetch;
    process.env.BRAIN_EMBEDDING_API_KEY = "test-query-embedding-key-never-sent";
    process.env.BRAIN_QUERY_EMBEDDINGS = "true";
    let requests = 0;
    let responseStatus = 200;
    globalThis.fetch = async (input, init) => {
      requests++;
      assert.equal(
        input instanceof Request ? input.url : String(input),
        "https://ai-gateway.vercel.sh/v1/embeddings",
      );
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, embeddingModel());
      assert.equal(body.dimensions, 1536);
      assert.equal(typeof body.input, "string");
      assert.ok(
        !body.input.includes("Saffron Loom") || body.input === "Saffron Loom",
      );
      return responseStatus === 200
        ? Response.json({
            data: [{ embedding: vector, index: 0 }],
            model: embeddingModel(),
          })
        : Response.json(
            { error: "Mock provider failure" },
            { status: responseStatus },
          );
    };
    try {
      const page = await write(owner, {
        title: "Saffron Loom",
        type: "project",
        markdown: "Handles artisanal weaving.",
        expectedVersion: 0,
      });
      await indexPageFixture(owner, page, vector);
      const otherPage = await write(owner, {
        title: "Orchard Planning",
        type: "project",
        markdown: "Seasonal crop schedule.",
        expectedVersion: 0,
      });
      await indexPageFixture(owner, otherPage, otherVector);
      const privatePage = await write(outsider, {
        title: "Other Owner",
        type: "project",
        markdown: "Private test fixture.",
        expectedVersion: 0,
      });

      await indexPageFixture(outsider, privatePage, vector);

      await t.test(
        "authentication and explicit vector validation precede the provider",
        async () => {
          const before = requests;
          await assert.rejects(
            search("", { query: "anything" }),
            (error) => error instanceof BrainError && error.status === 401,
          );
          await assert.rejects(
            search(owner, {
              query: "anything",
              embedding: vector,
              embeddingModel: "different/model",
            }),
            (error) =>
              error instanceof BrainError &&
              error.code === "EMBEDDING_MODEL_MISMATCH",
          );
          assert.equal(requests, before);
        },
      );

      await t.test(
        "server-generated vectors find pages with no lexical overlap",
        async () => {
          const before = requests;
          const result = await search(owner, {
            query: `semantic-probe-${randomUUID()}`,
            expandGraph: false,
          });
          assert.equal(requests, before + 1);
          assert.equal(result.results.length, 2);
          assert.equal(result.results[0].id, page.id);
          assert.deepEqual(result.results[0].matchedBy, ["vector"]);
          assert.deepEqual(result.retrieval, {
            mode: "hybrid",
            embeddingModel: embeddingModel(),
            embeddingSource: "server",
          });
        },
      );

      await t.test(
        "supplied vectors bypass provider calls and keep client metadata",
        async () => {
          const before = requests;
          responseStatus = 503;
          const result = await search(owner, {
            query: `explicit-probe-${randomUUID()}`,
            embedding: vector,
            embeddingModel: embeddingModel(),
            expandGraph: false,
          });
          assert.equal(requests, before);
          assert.equal(result.results[0].id, page.id);
          assert.deepEqual(result.retrieval, {
            mode: "hybrid",
            embeddingModel: embeddingModel(),
            embeddingSource: "client",
          });
        },
      );

      await t.test(
        "context generates a vector once and reports its effective retrieval mode",
        async () => {
          responseStatus = 200;
          const before = requests;
          const bundle = await context(owner, {
            query: `context-probe-${randomUUID()}`,
            refs: [page.id],
          });
          assert.equal(requests, before + 1);
          assert.equal(bundle.retrieval.mode, "hybrid");
          assert.equal(bundle.retrieval.embeddingSource, "server");
          assert.equal(bundle.retrieval.embeddingModel, embeddingModel());
          assert.equal(bundle.citations.length, 2);
          assert.ok(
            !bundle.gaps.some((gap) =>
              gap.includes("embeddings are unavailable"),
            ),
          );
        },
      );

      await t.test(
        "provider failure preserves lexical search and context without a second attempt",
        async () => {
          responseStatus = 503;
          const before = requests;
          const result = await search(owner, {
            query: "Saffron",
            expandGraph: false,
          });
          assert.equal(requests, before + 1);
          assert.equal(result.results[0].id, page.id);
          assert.deepEqual(result.results[0].matchedBy, ["text"]);
          assert.deepEqual(result.retrieval, {
            mode: "text-and-graph",
            embeddingModel: null,
            embeddingSource: "unavailable",
          });
          const beforeContext = requests;
          const bundle = await context(owner, {
            query: `failed-context-${randomUUID()}`,
            refs: [page.id],
          });
          assert.equal(requests, beforeContext + 1);
          assert.equal(bundle.citations[0].id, page.id);
          assert.equal(bundle.retrieval.mode, "text-and-graph");
          assert.equal(bundle.retrieval.embeddingSource, "unavailable");
          assert.equal(bundle.retrieval.embeddingModel, null);
          assert.ok(
            bundle.gaps.some((gap) =>
              gap.includes("embeddings are unavailable"),
            ),
          );
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.BRAIN_EMBEDDING_API_KEY;
      else process.env.BRAIN_EMBEDDING_API_KEY = originalKey;
      if (originalEnabled === undefined)
        delete process.env.BRAIN_QUERY_EMBEDDINGS;
      else process.env.BRAIN_QUERY_EMBEDDINGS = originalEnabled;
      await getPool().query(
        "DELETE FROM brain_pages WHERE owner_id=ANY($1::text[])",
        [[owner, outsider]],
      );
      await getPool().end();
    }
  },
);
