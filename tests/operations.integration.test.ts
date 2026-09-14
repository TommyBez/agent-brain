import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { write } from "../lib/brain/service";
import { BrainError } from "../lib/brain/types";
import { getPool } from "../lib/db";
import {
  claimJob,
  enqueueNightly,
  exportBrain,
  finishJob,
  operationsStatus,
} from "../lib/operations";

test(
  "nightly leases, durable-export acknowledgment and scoped snapshots",
  { skip: process.env.RUN_DB_TESTS !== "1" },
  async (t) => {
    const owner = `operations-test-${randomUUID()}`;
    const outsider = `operations-test-${randomUUID()}`;
    try {
      assert.equal((await enqueueNightly(owner)).length, 2);
      assert.equal((await enqueueNightly(owner)).length, 0);
      const concurrent = await Promise.all([
        claimJob(owner, "consolidation"),
        claimJob(owner, "consolidation"),
      ]);
      assert.equal(concurrent.filter(Boolean).length, 1);
      const claimed = concurrent.find(Boolean);
      assert.ok(claimed);

      await t.test(
        "only the current live owner lease can acknowledge work",
        async () => {
          assert.equal(await claimJob(outsider, "consolidation"), null);
          await assert.rejects(
            finishJob(outsider, {
              id: claimed.id,
              leaseId: claimed.leaseId,
              status: "succeeded",
            }),
            (error) =>
              error instanceof BrainError && error.code === "LEASE_EXPIRED",
          );
          await getPool().query(
            "UPDATE brain_jobs SET lease_until=now()-interval '1 minute' WHERE owner_id=$1 AND id=$2",
            [owner, claimed.id],
          );
          await assert.rejects(
            finishJob(owner, {
              id: claimed.id,
              leaseId: claimed.leaseId,
              status: "succeeded",
            }),
            (error) =>
              error instanceof BrainError && error.code === "LEASE_EXPIRED",
          );
          const replacement = await claimJob(owner, "consolidation");
          assert.ok(replacement);
          assert.notEqual(replacement.leaseId, claimed.leaseId);
          await assert.rejects(
            finishJob(owner, {
              id: claimed.id,
              leaseId: claimed.leaseId,
              status: "succeeded",
            }),
            (error) =>
              error instanceof BrainError && error.code === "LEASE_EXPIRED",
          );
          await finishJob(owner, {
            id: replacement.id,
            leaseId: replacement.leaseId,
            status: "succeeded",
            result: { writes: 0 },
          });
          await assert.rejects(
            finishJob(owner, {
              id: replacement.id,
              leaseId: replacement.leaseId,
              status: "succeeded",
            }),
            (error) =>
              error instanceof BrainError && error.code === "LEASE_EXPIRED",
          );
        },
      );

      await t.test(
        "export completion requires a pushed commit receipt",
        async () => {
          const job = await claimJob(owner, "export");
          assert.ok(job);
          await assert.rejects(
            finishJob(owner, {
              id: job.id,
              leaseId: job.leaseId,
              status: "succeeded",
              result: { committed: false },
            }),
            (error) =>
              error instanceof BrainError &&
              error.code === "EXPORT_NOT_PERSISTED",
          );
          await finishJob(owner, {
            id: job.id,
            leaseId: job.leaseId,
            status: "succeeded",
            result: { pushed: true, commit: "a".repeat(40) },
          });
          assert.ok(
            (await operationsStatus(owner)).jobs.some(
              (entry) => entry.id === job.id && entry.status === "succeeded",
            ),
          );
        },
      );

      await t.test(
        "snapshot exports retain typed links and exclude other owners",
        async () => {
          const person = await write(owner, {
            title: "Export Tester",
            type: "person",
            markdown: "Temporary integration fixture.",
            expectedVersion: 0,
          });
          const project = await write(owner, {
            title: "Export Check",
            type: "project",
            markdown: "Temporary integration fixture.",
            expectedVersion: 0,
            links: [{ targetRef: person.id, type: "owns" }],
          });
          await write(outsider, {
            title: "Private outsider",
            type: "note",
            markdown: "Must never enter the export.",
            expectedVersion: 0,
          });
          const snapshot = await exportBrain(owner);
          assert.equal(snapshot.pages.length, 2);
          assert.equal(snapshot.links.length, 1);
          assert.equal(snapshot.links[0].sourceId, project.id);
          assert.equal(snapshot.links[0].targetSlug, person.slug);
          assert.ok(
            snapshot.pages.every(
              (page) => page.id === person.id || page.id === project.id,
            ),
          );
        },
      );

      await t.test(
        "exhausted crashed leases stop appearing as running",
        async () => {
          await getPool().query(
            "UPDATE brain_jobs SET attempts=4,status='running',lease_until=now()-interval '1 minute' WHERE owner_id=$1 AND id=$2",
            [owner, claimed.id],
          );
          assert.equal(await claimJob(owner, "consolidation"), null);
          assert.equal(
            (await operationsStatus(owner)).jobs.find(
              (job) => job.id === claimed.id,
            )?.status,
            "failed",
          );
        },
      );
    } finally {
      await getPool().query(
        "DELETE FROM brain_jobs WHERE owner_id=ANY($1::text[])",
        [[owner, outsider]],
      );
      await getPool().query(
        "DELETE FROM brain_pages WHERE owner_id=ANY($1::text[])",
        [[owner, outsider]],
      );
      await getPool().end();
    }
  },
);
