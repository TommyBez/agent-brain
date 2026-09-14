import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import * as brain from "../lib/brain/service";
import { BrainError } from "../lib/brain/types";
import { getPool } from "../lib/db";

test(
  "Workflow writes replay committed revision snapshots without repeating mutations",
  { skip: process.env.RUN_DB_TESTS !== "1" },
  async (t) => {
    const owner = `workflow-writes-${randomUUID()}`;
    const otherOwner = `workflow-writes-${randomUUID()}`;
    try {
      await t.test(
        "concurrent creation with one operation key commits once",
        async () => {
          const input = {
            title: "Workflow creation",
            type: "note",
            markdown: "Created once.",
            expectedVersion: 0,
          };
          const pages = await Promise.all(
            Array.from({ length: 3 }, () =>
              brain.write(owner, input, { operationKey: "run/create" }),
            ),
          );
          for (const page of pages) assert.deepEqual(page, pages[0]);
          assert.equal(pages[0].version, 1);
          assert.equal(
            (await brain.listRevisions(owner, { ref: pages[0].id })).length,
            1,
          );
          const activity = await getPool().query(
            "SELECT count(*)::integer AS count FROM brain_activity WHERE owner_id=$1 AND page_id=$2",
            [owner, pages[0].id],
          );
          assert.equal(activity.rows[0].count, 1);
        },
      );

      await t.test(
        "retry after a later external write returns its original snapshot",
        async () => {
          const initial = await brain.write(owner, {
            title: "Workflow replacement",
            type: "project",
            markdown: "Initial content.",
            expectedVersion: 0,
          });
          const input = {
            id: initial.id,
            title: initial.title,
            type: initial.type,
            markdown: "Consolidated content.",
            expectedVersion: initial.version,
          };
          const [committed, concurrentRetry] = await Promise.all([
            brain.write(owner, input, { operationKey: "run/replace" }),
            brain.write(owner, input, { operationKey: "run/replace" }),
          ]);
          assert.deepEqual(concurrentRetry, committed);
          assert.equal(committed.version, 2);
          const later = await brain.write(owner, {
            ...input,
            markdown: "An external agent made a later edit.",
            expectedVersion: committed.version,
          });
          const replay = await brain.write(owner, input, {
            operationKey: "run/replace",
          });
          assert.deepEqual(replay, committed);
          assert.deepEqual(await brain.read(owner, { ref: initial.id }), later);
          assert.equal(
            (await brain.listRevisions(owner, { ref: initial.id })).length,
            3,
          );
          await assert.rejects(
            brain.write(owner, input),
            (error) =>
              error instanceof BrainError && error.code === "VERSION_CONFLICT",
          );
        },
      );

      await t.test(
        "append retries do not duplicate text or overwrite subsequent edits",
        async () => {
          const initial = await brain.write(owner, {
            title: "Workflow append",
            type: "note",
            markdown: "Original paragraph.",
            expectedVersion: 0,
          });
          const input = {
            ref: initial.id,
            expectedVersion: initial.version,
            markdown: "One appended observation.",
          };
          const [committed, concurrentRetry] = await Promise.all([
            brain.append(owner, input, { operationKey: "run/append" }),
            brain.append(owner, input, { operationKey: "run/append" }),
          ]);
          assert.deepEqual(concurrentRetry, committed);
          assert.equal(committed.version, 2);
          const later = await brain.append(owner, {
            ...input,
            expectedVersion: committed.version,
            markdown: "A later observation.",
          });
          assert.deepEqual(
            await brain.append(owner, input, { operationKey: "run/append" }),
            committed,
          );
          const current = await brain.read(owner, { ref: initial.id });
          assert.deepEqual(current, later);
          assert.equal(current.markdown.split(input.markdown).length - 1, 1);
          assert.equal(
            (await brain.listRevisions(owner, { ref: initial.id })).length,
            3,
          );
        },
      );

      await t.test(
        "the same operation key is independent for each owner",
        async () => {
          const input = {
            title: "Shared operation key",
            type: "decision",
            markdown: "Separate owner content.",
            expectedVersion: 0,
          };
          const [first, second] = await Promise.all([
            brain.write(owner, input, { operationKey: "run/shared" }),
            brain.write(otherOwner, input, { operationKey: "run/shared" }),
          ]);
          assert.notEqual(first.id, second.id);
          assert.deepEqual(
            await brain.write(otherOwner, input, {
              operationKey: "run/shared",
            }),
            second,
          );
          await assert.rejects(
            brain.read(owner, { ref: second.id }),
            (error) =>
              error instanceof BrainError && error.code === "NOT_FOUND",
          );
        },
      );

      await t.test(
        "failed transactions do not reserve an operation key",
        async () => {
          const input = {
            title: "Retry after rollback",
            type: "note",
            markdown: "The first attempt had an invalid relationship.",
            expectedVersion: 0,
          };
          await assert.rejects(
            brain.write(
              owner,
              {
                ...input,
                links: [{ targetRef: randomUUID(), type: "references" }],
              },
              { operationKey: "run/rollback" },
            ),
            (error) =>
              error instanceof BrainError && error.code === "NOT_FOUND",
          );
          const created = await brain.write(owner, input, {
            operationKey: "run/rollback",
          });
          assert.equal(created.version, 1);
          assert.equal(
            (await brain.listRevisions(owner, { ref: created.id })).length,
            1,
          );
        },
      );

      await t.test(
        "internal operation keys reject blank and excessive values",
        async () => {
          for (const operationKey of ["", "   ", "x".repeat(257)]) {
            await assert.rejects(
              brain.write(owner, {}, { operationKey }),
              (error) =>
                error instanceof BrainError &&
                error.code === "INVALID_OPERATION_KEY",
            );
            await assert.rejects(
              brain.append(owner, {}, { operationKey }),
              (error) =>
                error instanceof BrainError &&
                error.code === "INVALID_OPERATION_KEY",
            );
          }
        },
      );
    } finally {
      await getPool().query(
        "DELETE FROM brain_pages WHERE owner_id=ANY($1::text[])",
        [[owner, otherOwner]],
      );
      await getPool().end();
    }
  },
);
