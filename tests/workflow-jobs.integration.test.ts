import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BrainError } from "../lib/brain/types";
import { getPool } from "../lib/db";
import {
  beginWorkflowJob,
  dailyWorkflowStatus,
  finishWorkflowJob,
  queueWorkflowJobs,
  workflowExportAttemptKey,
} from "../lib/maintenance/jobs";

test("export receipt keys change only with the logical job attempt", () => {
  const jobId = randomUUID();
  assert.equal(workflowExportAttemptKey(jobId, 1), jobId);
  assert.equal(workflowExportAttemptKey(jobId, 2), `${jobId}-attempt-2`);
  assert.equal(
    workflowExportAttemptKey(jobId, 2),
    workflowExportAttemptKey(jobId, 2),
  );
  assert.notEqual(
    workflowExportAttemptKey(jobId, 2),
    workflowExportAttemptKey(jobId, 3),
  );
  for (const attempts of [0, -1, 1.5, Number.NaN])
    assert.throws(
      () => workflowExportAttemptKey(jobId, attempts),
      (error) =>
        error instanceof BrainError && error.code === "INVALID_JOB_ATTEMPT",
    );
});

test(
  "Workflow daily jobs track bounded passes and fence stale run completions",
  { skip: process.env.RUN_DB_TESTS !== "1" },
  async (t) => {
    const owner = `workflow-jobs-${randomUUID()}`;
    const outsider = `workflow-jobs-${randomUUID()}`;
    const runDate = "2035-01-15";
    async function initialFailedPass(date: string) {
      const consolidation = await beginWorkflowJob(
        owner,
        "consolidation",
        date,
        "initial-run",
      );
      await finishWorkflowJob(
        owner,
        consolidation.id,
        "initial-run",
        "failed",
        {},
        "Temporary model failure.",
      );
      const embeddings = await beginWorkflowJob(
        owner,
        "embeddings",
        date,
        "initial-run",
      );
      const exported = await beginWorkflowJob(
        owner,
        "export",
        date,
        "initial-run",
      );
      await finishWorkflowJob(owner, embeddings.id, "initial-run", "partial", {
        remaining: 1,
        budgetReached: true,
      });
      await finishWorkflowJob(owner, exported.id, "initial-run", "succeeded", {
        pushed: true,
        commit: "d".repeat(40),
      });
      return { consolidation, embeddings, exported };
    }
    try {
      await t.test(
        "a consolidation retry that changes pages requeues both prior outputs atomically",
        async () => {
          for (const [index, status] of (
            ["succeeded", "partial"] as const
          ).entries()) {
            const date = `2035-01-${21 + index}`;
            const original = await initialFailedPass(date);
            const retried = await beginWorkflowJob(
              owner,
              "consolidation",
              date,
              "corrected-run",
            );
            assert.equal(retried.attempts, 2);
            const completion = await finishWorkflowJob(
              owner,
              retried.id,
              "corrected-run",
              status,
              { writes: 2 },
            );
            const jobs = await dailyWorkflowStatus(owner, date);
            assert.equal(
              jobs.find((job) => job.id === retried.id)?.status,
              status,
            );
            for (const previous of [original.embeddings, original.exported]) {
              const queued = jobs.find((job) => job.id === previous.id);
              assert.equal(queued?.status, "queued");
              assert.equal(queued.attempts, 1);
              assert.equal(queued.workflowRunId, null);
              assert.equal(queued.result, null);
            }
            assert.deepEqual(
              await finishWorkflowJob(
                owner,
                retried.id,
                "corrected-run",
                status,
                { writes: 99 },
              ),
              completion,
            );
            const refreshed = await Promise.all([
              beginWorkflowJob(owner, "embeddings", date, "corrected-run"),
              beginWorkflowJob(owner, "export", date, "corrected-run"),
            ]);
            for (const job of refreshed) {
              assert.equal(job.skip, false);
              assert.equal(job.attempts, 2);
              assert.deepEqual(
                await beginWorkflowJob(owner, job.kind, date, "corrected-run"),
                job,
              );
              await finishWorkflowJob(
                owner,
                job.id,
                "corrected-run",
                "succeeded",
                job.kind === "export"
                  ? { pushed: true, commit: "e".repeat(40) }
                  : { remaining: 0 },
              );
            }
            assert.equal(
              workflowExportAttemptKey(
                original.exported.id,
                refreshed[1].attempts,
              ),
              `${original.exported.id}-attempt-2`,
            );
            assert.deepEqual(
              await finishWorkflowJob(
                owner,
                retried.id,
                "corrected-run",
                status,
                { writes: 2 },
              ),
              completion,
            );
            assert.ok(
              (await dailyWorkflowStatus(owner, date)).every((job) =>
                ["succeeded", "partial"].includes(job.status),
              ),
            );
            assert.equal(
              (
                await beginWorkflowJob(
                  owner,
                  "consolidation",
                  date,
                  "later-run",
                )
              ).skip,
              true,
            );
            assert.equal(
              (await beginWorkflowJob(owner, "export", date, "later-run")).skip,
              true,
            );
          }
        },
      );

      await t.test(
        "retried consolidation refreshes outputs even when failure lost its write count",
        async () => {
          for (const [index, status] of (
            ["failed", "succeeded"] as const
          ).entries()) {
            const date = `2035-01-${24 + index}`;
            const original = await initialFailedPass(date);
            const retried = await beginWorkflowJob(
              owner,
              "consolidation",
              date,
              "unknown-writes-run",
            );
            const result = status === "failed" ? {} : { writes: 0 };
            const completed = await finishWorkflowJob(
              owner,
              retried.id,
              "unknown-writes-run",
              status,
              result,
            );
            const jobs = await dailyWorkflowStatus(owner, date);
            assert.equal(
              jobs.find((job) => job.id === original.embeddings.id)?.status,
              "queued",
            );
            assert.equal(
              jobs.find((job) => job.id === original.exported.id)?.status,
              "queued",
            );
            assert.deepEqual(
              await finishWorkflowJob(
                owner,
                retried.id,
                "unknown-writes-run",
                status,
                result,
              ),
              completed,
            );
          }
        },
      );

      await t.test(
        "a first consolidation pass with no writes does not invalidate existing outputs",
        async () => {
          const date = "2035-01-26";
          const embeddings = await beginWorkflowJob(
            owner,
            "embeddings",
            date,
            "prior-output-run",
          );
          const exported = await beginWorkflowJob(
            owner,
            "export",
            date,
            "prior-output-run",
          );
          await finishWorkflowJob(
            owner,
            embeddings.id,
            "prior-output-run",
            "succeeded",
            { remaining: 0 },
          );
          await finishWorkflowJob(
            owner,
            exported.id,
            "prior-output-run",
            "succeeded",
            { pushed: true, commit: "f".repeat(40) },
          );
          const consolidation = await beginWorkflowJob(
            owner,
            "consolidation",
            date,
            "first-consolidation-run",
          );
          assert.equal(consolidation.attempts, 1);
          await finishWorkflowJob(
            owner,
            consolidation.id,
            "first-consolidation-run",
            "succeeded",
            { writes: 0 },
          );
          const jobs = await dailyWorkflowStatus(owner, date);
          assert.ok(jobs.every((job) => job.status === "succeeded"));
        },
      );

      await t.test(
        "start queues all stages once without resetting completed work",
        async () => {
          const date = "2035-01-20";
          await Promise.all([
            queueWorkflowJobs(owner, date),
            queueWorkflowJobs(owner, date),
          ]);
          const queued = await dailyWorkflowStatus(owner, date);
          assert.equal(queued.length, 3);
          assert.ok(queued.every((job) => job.status === "queued"));
          const job = await beginWorkflowJob(
            owner,
            "consolidation",
            date,
            "queue-run",
          );
          await finishWorkflowJob(owner, job.id, "queue-run", "succeeded", {
            writes: 0,
          });
          await queueWorkflowJobs(owner, date);
          const after = await dailyWorkflowStatus(owner, date);
          assert.equal(after.length, 3);
          assert.equal(
            after.find((entry) => entry.id === job.id)?.status,
            "succeeded",
          );
        },
      );
      await t.test(
        "concurrent begin retries create one daily job and count one attempt",
        async () => {
          const [first, second] = await Promise.all([
            beginWorkflowJob(owner, "consolidation", runDate, "run-first"),
            beginWorkflowJob(owner, "consolidation", runDate, "run-first"),
          ]);
          assert.deepEqual(first, second);
          assert.equal(first.status, "running");
          assert.equal(first.attempts, 1);
          assert.equal(first.skip, false);
          assert.equal((await dailyWorkflowStatus(owner, runDate)).length, 1);
        },
      );

      await t.test(
        "replacement runs fence old finishes and completion retries preserve results",
        async () => {
          const old = await beginWorkflowJob(
            owner,
            "consolidation",
            runDate,
            "run-first",
          );
          const replacement = await beginWorkflowJob(
            owner,
            "consolidation",
            runDate,
            "run-replacement",
          );
          assert.equal(replacement.id, old.id);
          assert.equal(replacement.attempts, 2);
          await assert.rejects(
            finishWorkflowJob(owner, old.id, "run-first", "succeeded"),
            (error) =>
              error instanceof BrainError &&
              error.code === "WORKFLOW_RUN_SUPERSEDED",
          );
          await assert.rejects(
            finishWorkflowJob(outsider, old.id, "run-replacement", "succeeded"),
            (error) =>
              error instanceof BrainError &&
              error.code === "WORKFLOW_RUN_SUPERSEDED",
          );
          const finished = await finishWorkflowJob(
            owner,
            replacement.id,
            "run-replacement",
            "succeeded",
            { writes: 3 },
          );
          assert.deepEqual(
            await finishWorkflowJob(
              owner,
              replacement.id,
              "run-replacement",
              "succeeded",
              { writes: 99 },
            ),
            finished,
          );
          await assert.rejects(
            finishWorkflowJob(
              owner,
              replacement.id,
              "run-replacement",
              "failed",
            ),
            (error) =>
              error instanceof BrainError &&
              error.code === "WORKFLOW_JOB_FINISHED",
          );
          const skipped = await beginWorkflowJob(
            owner,
            "consolidation",
            runDate,
            "run-next",
          );
          assert.equal(skipped.skip, true);
          assert.equal(skipped.attempts, 2);
          assert.deepEqual(skipped.result, { writes: 3 });
        },
      );

      await t.test(
        "partial jobs consume the daily pass but failed jobs can restart",
        async () => {
          const initial = await beginWorkflowJob(
            owner,
            "embeddings",
            runDate,
            "run-first",
          );
          await finishWorkflowJob(
            owner,
            initial.id,
            "run-first",
            "failed",
            undefined,
            "x".repeat(2500),
          );
          const failed = (await dailyWorkflowStatus(owner, runDate)).find(
            (job) => job.id === initial.id,
          );
          assert.equal(failed?.error?.length, 2000);
          const retried = await beginWorkflowJob(
            owner,
            "embeddings",
            runDate,
            "run-retry",
          );
          assert.equal(retried.id, initial.id);
          assert.equal(retried.attempts, 2);
          assert.equal(retried.error, null);
          await finishWorkflowJob(owner, initial.id, "run-retry", "partial", {
            budgetReached: true,
            pendingChunks: 12,
          });
          const skipped = await beginWorkflowJob(
            owner,
            "embeddings",
            runDate,
            "run-later",
          );
          assert.equal(skipped.skip, true);
          assert.equal(skipped.status, "partial");
          assert.equal(skipped.attempts, 2);
          const tomorrow = await beginWorkflowJob(
            owner,
            "embeddings",
            "2035-01-16",
            "run-tomorrow",
          );
          assert.notEqual(tomorrow.id, initial.id);
          assert.equal(tomorrow.skip, false);
          assert.equal(tomorrow.attempts, 1);
        },
      );

      await t.test(
        "successful exports require pushed commits with valid SHA lengths",
        async () => {
          const job = await beginWorkflowJob(
            owner,
            "export",
            runDate,
            "run-export",
          );
          for (const result of [
            {},
            { pushed: false, commit: "a".repeat(40) },
            { pushed: true, commit: "a".repeat(41) },
            { pushed: true, commit: "z".repeat(40) },
          ]) {
            await assert.rejects(
              finishWorkflowJob(
                owner,
                job.id,
                "run-export",
                "succeeded",
                result,
              ),
              (error) =>
                error instanceof BrainError &&
                error.code === "EXPORT_NOT_PERSISTED",
            );
          }
          const receipt = { pushed: true, commit: "a".repeat(40) };
          const finished = await finishWorkflowJob(
            owner,
            job.id,
            "run-export",
            "succeeded",
            receipt,
          );
          assert.deepEqual(finished.result, receipt);
          assert.deepEqual(
            await finishWorkflowJob(owner, job.id, "run-export", "succeeded"),
            finished,
          );
        },
      );

      await t.test(
        "daily status keeps owner and date boundaries and includes every kind",
        async () => {
          await beginWorkflowJob(outsider, "export", runDate, "outsider-run");
          const jobs = await dailyWorkflowStatus(owner, runDate);
          assert.deepEqual(
            jobs.map((job) => job.kind),
            ["consolidation", "embeddings", "export"],
          );
          assert.ok(
            jobs.every(
              (job) => job.status === "succeeded" || job.status === "partial",
            ),
          );
          assert.equal(
            (await dailyWorkflowStatus(outsider, runDate)).length,
            1,
          );
          assert.deepEqual(await dailyWorkflowStatus(owner, "2035-01-17"), []);
        },
      );

      await t.test(
        "an existing Workflow queued job is adopted without losing its identity",
        async () => {
          const inserted = await getPool().query<{ id: string }>(
            "INSERT INTO brain_jobs (owner_id,kind,run_date,attempts) VALUES ($1,'export','2035-01-18',2) RETURNING id",
            [owner],
          );
          const job = await beginWorkflowJob(
            owner,
            "export",
            "2035-01-18",
            "adopted-run",
          );
          assert.equal(job.id, inserted.rows[0].id);
          assert.equal(job.attempts, 3);
          assert.equal(job.workflowRunId, "adopted-run");
        },
      );

      await t.test(
        "invalid dates and blank workflow IDs are rejected",
        async () => {
          for (const invalid of [
            "2035-02-30",
            "2035-1-01",
            "invalid",
            "0000-01-01",
          ]) {
            await assert.rejects(
              beginWorkflowJob(owner, "export", invalid, "run-valid"),
              (error) =>
                error instanceof BrainError &&
                error.code === "INVALID_RUN_DATE",
            );
          }
          await assert.rejects(
            beginWorkflowJob(owner, "export", runDate, " "),
            (error) =>
              error instanceof BrainError &&
              error.code === "INVALID_WORKFLOW_RUN",
          );
        },
      );
    } finally {
      await getPool().query(
        "DELETE FROM brain_jobs WHERE owner_id=ANY($1::text[])",
        [[owner, outsider]],
      );
      await getPool().end();
    }
  },
);
