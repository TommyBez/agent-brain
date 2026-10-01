import assert from "node:assert/strict";
import test from "node:test";
import { readConsolidationPages } from "../lib/brain/consolidation";
import * as brain from "../lib/brain/service";
import { BrainError } from "../lib/brain/types";
import { getPool } from "../lib/db";
import { initializeConsolidation } from "../lib/maintenance/consolidator/steps";
import {
  applyConsolidationChangeSet,
  readConsolidationRecord,
} from "../lib/maintenance/consolidator/store";
import { indexPageFixture } from "./helpers/brain-embeddings";
import { changeSet, storeFixture } from "./helpers/consolidator-store";

test(
  "consolidation store: snapshot",
  { skip: !process.env.BRAIN_TEST_DATABASE_URL },
  async (t) => {
    const { owner, otherOwner, create, cleanup } = storeFixture();
    try {
      await t.test(
        "initialization starts automatic consolidation without a mode selector",
        async () => {
          const runId = "automatic-initialization";
          const options = await initializeConsolidation(owner, runId);
          assert.equal("mode" in options, false);
          assert.equal("maxWaves" in options, false);
          assert.ok(options.taskBudget > 0);
          assert.deepEqual(await readConsolidationRecord(owner, runId, "run"), {
            status: "started",
          });
        },
      );
      await t.test(
        "the snapshot includes every page, full bodies and owner-scoped graph",
        async () => {
          for (let i = 0; i < 35; i++) await create();
          const hidden = await create(otherOwner);
          const pages = await readConsolidationPages(owner);
          assert.equal(pages.length, 35);
          assert.ok(
            pages.every(
              (page) => page.markdown === "A distinct documented fact.",
            ),
          );
          assert.ok(!pages.some((page) => page.id === hidden.id));
          const linkSource = await brain.write(owner, {
            id: pages[0].id,
            expectedVersion: pages[0].version,
            title: pages[0].title,
            type: pages[0].type,
            markdown: pages[0].markdown,
            links: [
              { targetRef: pages[1].id, type: "references", label: "Source" },
            ],
          });
          const snapshot = await readConsolidationPages(owner);
          assert.equal(
            snapshot.find((page) => page.id === linkSource.id)?.links[0]
              .targetId,
            pages[1].id,
          );
          assert.equal(
            snapshot.find((page) => page.id === pages[1].id)?.backlinks[0]
              .sourceId,
            linkSource.id,
          );
        },
      );
      await t.test(
        "changes to evidence or any target invalidate the entire group",
        async () => {
          const a = await create();
          const b = await create();
          const evidence = await create();
          const set = changeSet([a, b], [evidence]);
          await brain.append(owner, {
            ref: evidence.id,
            expectedVersion: 1,
            markdown: "Evidence changed.",
          });
          assert.deepEqual(
            await applyConsolidationChangeSet(owner, set, "evidence-conflict"),
            { status: "conflict", pageIds: [evidence.id] },
          );
          assert.equal((await brain.read(owner, { ref: a.id })).version, 1);
          assert.equal((await brain.read(owner, { ref: b.id })).version, 1);
          const next = changeSet([a, b]);
          await brain.append(owner, {
            ref: b.id,
            expectedVersion: 1,
            markdown: "Target changed.",
          });
          assert.deepEqual(
            await applyConsolidationChangeSet(owner, next, "target-conflict"),
            { status: "conflict", pageIds: [b.id] },
          );
          assert.equal((await brain.read(owner, { ref: a.id })).version, 1);
        },
      );
      await t.test(
        "concurrent retries commit one group and replay the same receipt after later writes",
        async () => {
          const a = await create();
          const b = await create();
          const set = changeSet([a, b]);
          const results = await Promise.all([
            applyConsolidationChangeSet(owner, set, "group-retry"),
            applyConsolidationChangeSet(owner, set, "group-retry"),
          ]);
          assert.deepEqual(results.map((result) => result.status).sort(), [
            "applied",
            "replayed",
          ]);
          const applied = results.find((result) => result.status === "applied");
          assert.ok(applied && "pages" in applied);
          assert.ok(applied.pages.every((page) => page.version === 2));
          await brain.append(owner, {
            ref: a.id,
            expectedVersion: 2,
            markdown: "A later independent write.",
          });
          assert.deepEqual(
            await applyConsolidationChangeSet(owner, set, "group-retry"),
            { status: "replayed", pages: applied.pages },
          );
          assert.equal((await brain.read(owner, { ref: a.id })).version, 3);
          const counts = await getPool().query(
            "SELECT count(*)::int AS count FROM brain_activity WHERE owner_id=$1 AND source='nightly-consolidation' AND page_id=ANY($2::uuid[])",
            [owner, [a.id, b.id]],
          );
          assert.equal(counts.rows[0].count, 2);
          const altered = structuredClone(set);
          altered.changes[0].after.markdown += " Different.";
          await assert.rejects(
            applyConsolidationChangeSet(owner, altered, "group-retry"),
            (error) =>
              error instanceof BrainError &&
              error.code === "OPERATION_KEY_CONFLICT",
          );
        },
      );
      await t.test(
        "overlapping groups serialize and one becomes stale",
        async () => {
          const a = await create();
          const b = await create();
          const results = await Promise.all([
            applyConsolidationChangeSet(owner, changeSet([a, b]), "overlap-a"),
            applyConsolidationChangeSet(owner, changeSet([b, a]), "overlap-b"),
          ]);
          assert.deepEqual(results.map((result) => result.status).sort(), [
            "applied",
            "conflict",
          ]);
          assert.equal((await brain.read(owner, { ref: a.id })).version, 2);
          assert.equal((await brain.read(owner, { ref: b.id })).version, 2);
        },
      );
      await t.test(
        "foreign-owner targets and incomplete read sets cannot write",
        async () => {
          const a = await create();
          const hidden = await create(otherOwner);
          const set = changeSet([a], [hidden]);
          assert.deepEqual(
            await applyConsolidationChangeSet(owner, set, "foreign-evidence"),
            { status: "conflict", pageIds: [hidden.id] },
          );
          set.plan.readSet = [];
          await assert.rejects(
            applyConsolidationChangeSet(owner, set, "missing-read-set"),
          );
          assert.equal((await brain.read(owner, { ref: a.id })).version, 1);
        },
      );
      await t.test(
        "links, immutable metadata, revisions and chunk invalidation follow saved state",
        async () => {
          let a = await create();
          const b = await create();
          const c = await create();
          a = await brain.write(owner, {
            id: a.id,
            expectedVersion: a.version,
            title: a.title,
            type: a.type,
            markdown: a.markdown,
            summary: "Keep this summary.",
            aliases: ["Preserved alias"],
            tags: ["preserved"],
            links: [{ targetRef: b.id, type: "references", label: "Original" }],
          });
          await indexPageFixture(
            owner,
            a,
            Array.from({ length: 1536 }, (_, index) => Number(index === 0)),
          );
          a = await brain.read(owner, { ref: a.id });
          const set = changeSet([a], [c]);
          set.changes[0].after.summary =
            "Updated summary verified against the original sources.";
          const added = {
            sourceId: a.id,
            targetId: c.id,
            type: "depends_on" as const,
            label: "Verified dependency",
          };
          set.draft.links.push(added);
          set.changes[0].after.links = [
            ...a.links,
            { ...added, id: "draft-link" },
          ];
          const result = await applyConsolidationChangeSet(
            owner,
            set,
            "with-links",
          );
          assert.ok("pages" in result);
          const saved = result.pages[0];
          assert.deepEqual(saved, await brain.read(owner, { ref: a.id }));
          assert.equal(
            saved.links.find((link) => link.targetId === b.id)?.id,
            a.links[0].id,
          );
          assert.equal(
            saved.links.find((link) => link.targetId === c.id)?.type,
            "depends_on",
          );
          assert.equal(saved.summary, set.changes[0].after.summary);
          assert.equal(saved.slug, a.slug);
          assert.deepEqual(saved.aliases, a.aliases);
          assert.deepEqual(saved.tags, a.tags);
          assert.equal(saved.embeddedAt, null);
          assert.ok(
            (await brain.listPendingEmbeddings(owner, 100)).some(
              (page) => page.id === a.id,
            ),
          );
          const revisions = await brain.listRevisionSummaries(owner, {
            ref: a.id,
          });
          assert.deepEqual(
            (
              await brain.readRevision(owner, {
                ref: a.id,
                version: revisions[0].version,
              })
            ).snapshot,
            saved,
          );
          const tampered = changeSet([saved]);
          tampered.changes[0].after.title = "Unauthorized title";
          await assert.rejects(
            applyConsolidationChangeSet(owner, tampered, "tampered"),
            (error) =>
              error instanceof BrainError &&
              error.code === "INVALID_CHANGE_SET",
          );
        },
      );
    } finally {
      await cleanup();
    }
  },
);
