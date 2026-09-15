import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import * as brain from "../lib/brain/service";
import type { BrainPage } from "../lib/brain/types";
import { embeddingModel } from "../lib/brain/utils";
import { getPool } from "../lib/db";
import { createBrainHandler } from "../lib/mcp/server";

test(
  "workspace pagination and successful MCP mutations preserve cache boundaries",
  { skip: process.env.RUN_DB_TESTS !== "1" },
  async (t) => {
    const ownerId = `workspace-test-${randomUUID()}`;
    const otherOwner = `workspace-test-${randomUUID()}`;
    let invalidations = 0;
    const handler = createBrainHandler(
      {
        ownerId,
        kind: "token",
        scopes: ["brain:read", "brain:write", "brain:maintain"],
      },
      () => {
        invalidations += 1;
      },
    );
    const client = new Client(
      { name: "workspace-cache-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL("https://brain.example/mcp"),
          {
            fetch: (input, init) => handler.fetch(new Request(input, init)),
          },
        ),
      );
      await t.test(
        "sorting runs before pagination and filtered totals survive empty pages",
        async () => {
          for (const title of ["Zulu", "alpha", "Bravo"])
            await brain.write(ownerId, {
              title,
              type: "note",
              markdown: "Pagination fixture.",
              expectedVersion: 0,
            });
          await brain.write(otherOwner, {
            title: "Aardvark",
            type: "note",
            markdown: "Another owner's fixture.",
            expectedVersion: 0,
          });
          const first = await brain.listPages(ownerId, {
            sort: "title",
            limit: 1,
          });
          const second = await brain.listPages(ownerId, {
            sort: "title",
            limit: 1,
            offset: 1,
          });
          assert.equal(first.pages[0].title, "alpha");
          assert.equal(second.pages[0].title, "Bravo");
          assert.equal(first.total, 3);
          assert.equal(second.total, 3);
          assert.equal(
            (await brain.listPages(ownerId, { limit: 1 })).pages[0].title,
            "Bravo",
          );
          const beyond = await brain.listPages(ownerId, {
            type: "note",
            query: "alpha",
            offset: 5,
          });
          assert.deepEqual(beyond.pages, []);
          assert.equal(beyond.total, 1);
          assert.equal(
            (await brain.listPages(ownerId, { type: "person" })).total,
            0,
          );
        },
      );
      await t.test(
        "write, append, and both index paths invalidate only after success",
        async () => {
          const created = await client.callTool({
            name: "write",
            arguments: {
              title: "MCP cache fixture",
              type: "project",
              markdown: "A durable observation.",
              expectedVersion: 0,
            },
          });
          assert.equal(created.isError, undefined);
          const page = (created.structuredContent as { data: BrainPage }).data;
          assert.equal(invalidations, 1);
          const rejected = await client.callTool({
            name: "append",
            arguments: {
              ref: page.id,
              expectedVersion: 99,
              markdown: "Conflict.",
            },
          });
          assert.equal(rejected.isError, true);
          assert.equal(invalidations, 1);
          const appended = await client.callTool({
            name: "append",
            arguments: {
              ref: page.id,
              expectedVersion: page.version,
              markdown: "Another observation.",
            },
          });
          assert.equal(appended.isError, undefined);
          assert.equal(invalidations, 2);
          const current = (appended.structuredContent as { data: BrainPage })
            .data;
          const embedding = Array.from({ length: 1536 }, (_, i) =>
            i === 0 ? 1 : 0,
          );
          const legacy = await client.callTool({
            name: "index_embedding",
            arguments: {
              ref: current.id,
              expectedVersion: current.version,
              embeddingModel: embeddingModel(),
              embedding,
            },
          });
          assert.equal(legacy.isError, undefined);
          assert.equal(invalidations, 3);
          const pending = (await brain.listPendingEmbeddings(ownerId)).find(
            (item) => item.id === current.id,
          );
          assert.ok(pending);
          const indexed = await client.callTool({
            name: "index_chunks",
            arguments: {
              ref: current.id,
              expectedVersion: current.version,
              embeddingModel: pending.embeddingModel,
              chunkerVersion: pending.chunkerVersion,
              embeddings: pending.chunks.map(({ contentHash }) => ({
                contentHash,
                embedding,
              })),
            },
          });
          assert.equal(indexed.isError, undefined);
          assert.equal(invalidations, 4);
          await client.callTool({
            name: "read",
            arguments: { ref: current.id },
          });
          assert.equal(invalidations, 4);
        },
      );
    } finally {
      await client.close();
      await getPool().query(
        "DELETE FROM brain_pages WHERE owner_id=ANY($1::text[])",
        [[ownerId, otherOwner]],
      );
      await getPool().end();
    }
  },
);
