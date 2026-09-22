import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import * as brain from "../lib/brain/service";
import { BrainError } from "../lib/brain/types";
import { getPool } from "../lib/db";

test(
  "Consolidation snapshot writes retain revisions and receipts without version rejection",
  { skip: process.env.RUN_DB_TESTS !== "1" },
  async (t) => {
    const owner = `consolidation-writer-${randomUUID()}`;
    try {
      const target = await brain.write(owner, {
        title: "A referenced decision",
        type: "decision",
        markdown: "The recorded decision.",
        expectedVersion: 0,
      });
      const initial = await brain.write(owner, {
        title: "Snapshot target",
        type: "project",
        summary: "Evaluated summary",
        aliases: ["Snapshot alias"],
        tags: ["evaluated"],
        markdown: "Original paragraph.",
        links: [{ targetRef: target.id, type: "decided_in", label: "Source" }],
        expectedVersion: 0,
      });
      await t.test(
        "stale snapshots commit once and can be restored",
        async () => {
          const ordinaryInput = {
            id: initial.id,
            title: initial.title,
            type: initial.type,
            markdown: "A concurrent update whose overwrite is accepted.",
            expectedVersion: initial.version,
          };
          await brain.write(owner, ordinaryInput);
          await assert.rejects(
            brain.write(owner, ordinaryInput),
            (error) =>
              error instanceof BrainError && error.code === "VERSION_CONFLICT",
          );
          const evaluated = { ...initial, markdown: "Consolidated paragraph." };
          const options = { operationKey: "nightly/apply" };
          const [committed, retry] = await Promise.all([
            brain.applyConsolidationSnapshot(owner, evaluated, options),
            brain.applyConsolidationSnapshot(owner, evaluated, options),
          ]);
          assert.deepEqual(retry, committed);
          assert.equal(committed.version, 3);
          assert.equal(committed.markdown, evaluated.markdown);
          assert.equal(committed.summary, initial.summary);
          assert.deepEqual(committed.aliases, initial.aliases);
          assert.deepEqual(committed.tags, initial.tags);
          assert.equal(committed.links[0].targetId, target.id);
          assert.equal(committed.links[0].label, "Source");
          const restored = await brain.restoreConsolidationRevision(
            owner,
            { ref: initial.id, version: initial.version },
            { operationKey: "nightly/restore" },
          );
          assert.equal(restored.version, 4);
          assert.equal(restored.markdown, initial.markdown);
          assert.deepEqual(
            await brain.applyConsolidationSnapshot(owner, evaluated, options),
            committed,
          );
          assert.deepEqual(
            await brain.read(owner, { ref: initial.id }),
            restored,
          );
          assert.equal(
            (await brain.listRevisions(owner, { ref: initial.id })).length,
            4,
          );
        },
      );
      await t.test(
        "a retry receipt cannot authorize another target",
        async () => {
          await assert.rejects(
            brain.applyConsolidationSnapshot(owner, target, {
              operationKey: "nightly/apply",
            }),
            (error) =>
              error instanceof BrainError &&
              error.code === "OPERATION_KEY_CONFLICT",
          );
          await assert.rejects(
            brain.applyConsolidationSnapshot(
              owner,
              { ...target, id: randomUUID() },
              { operationKey: "nightly/missing" },
            ),
            (error) =>
              error instanceof BrainError && error.code === "NOT_FOUND",
          );
          assert.equal(
            (await brain.read(owner, { ref: target.id })).version,
            1,
          );
        },
      );
    } finally {
      await getPool().query("DELETE FROM brain_pages WHERE owner_id=$1", [
        owner,
      ]);
      await getPool().end();
    }
  },
);
