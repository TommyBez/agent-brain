import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { EMBEDDING_DIMENSIONS } from "../lib/brain/schemas";
import * as brain from "../lib/brain/service";
import { BrainError } from "../lib/brain/types";
import { embeddingModel } from "../lib/brain/utils";
import { getPool } from "../lib/db";

test(
  "Postgres memory lifecycle, isolation, conflicts, graph and retrieval",
  { skip: process.env.RUN_DB_TESTS !== "1" },
  async (t) => {
    const owner = `integration-${randomUUID()}`;
    const outsider = `integration-${randomUUID()}`;
    const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) =>
      i === 0 ? 1 : 0,
    );
    const otherVector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) =>
      i === 1 ? 1 : 0,
    );
    try {
      const client = await brain.write(owner, {
        title: "Aurora Research",
        type: "client",
        markdown: "A client researching the deep ocean.",
        aliases: ["Aurora"],
        expectedVersion: 0,
      });
      let project = await brain.write(owner, {
        title: "Abyss Observatory",
        type: "project",
        markdown: "The observatory maps hydrothermal vents.",
        expectedVersion: 0,
        links: [{ targetRef: client.slug, type: "part_of" }],
        embedding: vector,
        embeddingModel: embeddingModel(),
      });
      const outsiderPage = await brain.write(outsider, {
        title: "Private Blueprint",
        type: "decision",
        markdown: "Only the other owner can see this.",
        expectedVersion: 0,
      });

      await t.test(
        "canonical aliases resolve and concurrent duplicate creation is rejected",
        async () => {
          assert.equal(
            (await brain.resolve(owner, { name: " AURORA ", type: "client" }))
              .match?.id,
            client.id,
          );
          await assert.rejects(
            brain.write(owner, {
              title: "Different label",
              aliases: ["ＡＵＲＯＲＡ"],
              type: "client",
              markdown: "Duplicate.",
              expectedVersion: 0,
            }),
            (error) =>
              error instanceof BrainError && error.code === "DUPLICATE_ENTITY",
          );
          const concurrent = await Promise.allSettled(
            [1, 2].map(() =>
              brain.write(owner, {
                title: "Concurrent Note",
                type: "note",
                markdown: "Race test.",
                expectedVersion: 0,
              }),
            ),
          );
          assert.equal(
            concurrent.filter((result) => result.status === "fulfilled").length,
            1,
          );
          assert.equal(
            concurrent.filter((result) => result.status === "rejected").length,
            1,
          );
        },
      );

      await t.test(
        "all read and mutation paths enforce owner boundaries",
        async () => {
          await assert.rejects(
            brain.read(owner, { ref: outsiderPage.id }),
            (error) => error instanceof BrainError && error.status === 404,
          );
          assert.equal(
            (await brain.search(owner, { query: "Private Blueprint" })).length,
            0,
          );
          await assert.rejects(
            brain.write(owner, {
              title: "Forbidden Link",
              type: "note",
              markdown: "Should roll back.",
              expectedVersion: 0,
              links: [{ targetRef: outsiderPage.id, type: "references" }],
            }),
            (error) => error instanceof BrainError && error.status === 404,
          );
          assert.equal(
            (await brain.resolve(owner, { name: "Forbidden Link" })).match,
            null,
          );
          await assert.rejects(
            brain.append(owner, {
              ref: outsiderPage.id,
              expectedVersion: 1,
              markdown: "Forbidden",
            }),
            (error) => error instanceof BrainError && error.status === 404,
          );
        },
      );

      await t.test(
        "typed links, backlinks and related traversal return canonical entities",
        async () => {
          const stored = await brain.read(owner, { ref: project.slug });
          assert.equal(stored.links[0].targetId, client.id);
          assert.equal(
            (await brain.read(owner, { ref: client.id })).backlinks[0].sourceId,
            project.id,
          );
          assert.ok(
            (
              await brain.related(owner, { ref: client.id, depth: 2 })
            ).pages.some((page) => page.id === project.id),
          );
          assert.equal((await brain.getGraph(owner)).links.length, 1);
        },
      );

      await t.test(
        "explicit context refs expand outgoing links and decision backlinks without matching query tokens",
        async () => {
          const decisionIds: string[] = [];
          try {
            for (const title of ["Observation governance", "Sensor cadence"]) {
              const decision = await brain.write(owner, {
                title,
                type: "decision",
                markdown: "A sourced decision connected to the observatory.",
                expectedVersion: 0,
                links: [{ targetRef: project.id, type: "decided_in" }],
              });
              decisionIds.push(decision.id);
            }
            const bundle = await brain.context(owner, {
              query: "q9contextgapzz",
              refs: [project.id, project.slug],
              maxCharacters: 12000,
            });
            assert.equal(bundle.citations[0].id, project.id);
            assert.deepEqual(
              new Set(bundle.citations.map((page) => page.id)),
              new Set([project.id, client.id, ...decisionIds]),
            );
            assert.equal(bundle.citations.length, 4);
            assert.ok(bundle.markdown.length <= 12000);

            const direct = await brain.context(owner, {
              query: "Concurrent Note",
              refs: [project.id],
              limit: 2,
            });
            assert.deepEqual(
              direct.citations.map((page) => page.title),
              [project.title, "Concurrent Note"],
            );

            const bounded = await brain.context(owner, {
              query: "q9contextgapzz",
              refs: [project.id],
              limit: 1,
              maxCharacters: 1000,
            });
            assert.equal(bounded.citations.length, 1);
            assert.equal(bounded.citations[0].id, project.id);
            assert.ok(bounded.markdown.length <= 1000);
          } finally {
            await getPool().query(
              "DELETE FROM brain_pages WHERE owner_id=$1 AND id=ANY($2::uuid[])",
              [owner, decisionIds],
            );
          }
        },
      );

      await t.test(
        "fulltext and vectors participate in hybrid retrieval",
        async () => {
          assert.equal(
            (await brain.search(owner, { query: "hydrothermal" }))[0].id,
            project.id,
          );
          await brain.indexEmbedding(owner, {
            ref: client.id,
            expectedVersion: 1,
            embedding: otherVector,
            embeddingModel: embeddingModel(),
          });
          const matches = await brain.search(owner, {
            query: "submarine exploration",
            embedding: vector,
            embeddingModel: embeddingModel(),
            expandGraph: false,
          });
          assert.equal(matches[0].id, project.id);
          assert.ok(matches[0].matchedBy.includes("vector"));
        },
      );

      await t.test(
        "competing append versions have one winner and invalidate stale embeddings",
        async () => {
          const results = await Promise.allSettled(
            ["Observation one", "Observation two"].map((markdown) =>
              brain.append(owner, {
                ref: project.id,
                expectedVersion: 1,
                markdown,
              }),
            ),
          );
          assert.equal(
            results.filter((result) => result.status === "fulfilled").length,
            1,
          );
          const failed = results.find((result) => result.status === "rejected");
          assert.ok(
            failed?.status === "rejected" &&
              failed.reason instanceof BrainError &&
              failed.reason.code === "VERSION_CONFLICT",
          );
          project = await brain.read(owner, { ref: project.id });
          assert.equal(project.version, 2);
          assert.equal(project.embeddedAt, null);
          assert.equal(project.links.length, 1);
          await assert.rejects(
            brain.indexEmbedding(owner, {
              ref: project.id,
              expectedVersion: 1,
              embedding: vector,
              embeddingModel: embeddingModel(),
            }),
            (error) =>
              error instanceof BrainError && error.code === "VERSION_CONFLICT",
          );
          assert.equal(
            (await brain.listRevisions(owner, { ref: project.id })).length,
            2,
          );
          assert.ok(
            (await brain.listPendingEmbeddings(owner)).some(
              (page) => page.id === project.id,
            ),
          );
        },
      );

      await t.test(
        "replacement writes preserve history and replace outgoing links atomically",
        async () => {
          const replacement = await brain.write(owner, {
            id: project.id,
            expectedVersion: 2,
            title: project.title,
            type: project.type,
            markdown: project.markdown,
            aliases: ["Abyss"],
            links: [],
            reason: "Reviewed the project relationships",
          });
          assert.equal(replacement.version, 3);
          assert.equal(replacement.links.length, 0);
          assert.equal(
            (await brain.read(owner, { ref: client.id })).backlinks.length,
            0,
          );
          assert.equal(
            (await brain.resolve(owner, { name: "Abyss" })).match?.id,
            project.id,
          );
          assert.equal(
            (await brain.listRevisions(owner, { ref: project.id }))[1].snapshot
              .links.length,
            1,
          );
          project = replacement;
        },
      );

      await t.test(
        "context obeys its budget and preserves source/version citations",
        async () => {
          const bundle = await brain.context(owner, {
            query: "hydrothermal",
            refs: [project.id],
            maxCharacters: 1000,
          });
          assert.ok(bundle.markdown.length <= 1000);
          assert.equal(bundle.citations[0].id, project.id);
          assert.equal(bundle.citations[0].version, 3);
          assert.ok(bundle.markdown.includes(project.slug));
          assert.ok((await brain.gapAnalysis(owner)).pendingEmbeddings >= 1);
          assert.equal((await brain.listPages(owner)).total, 3);
          assert.equal((await brain.getStats(owner)).pages, 3);
          assert.ok(
            (await brain.listActivity(owner)).some(
              (event) => event.action === "append",
            ),
          );
          const longQuery = await brain.context(owner, {
            query: "x".repeat(1000),
            refs: [project.id],
            maxCharacters: 1000,
          });
          assert.ok(longQuery.markdown.length <= 1000);
        },
      );
    } finally {
      await getPool().query(
        "DELETE FROM brain_pages WHERE owner_id=ANY($1::text[])",
        [[owner, outsider]],
      );
      await getPool().end();
    }
  },
);
