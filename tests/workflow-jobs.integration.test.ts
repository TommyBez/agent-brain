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
} from "../lib/maintenance/jobs";

test(
  "Workflow daily jobs track bounded passes and fence stale run completions",
  { skip: process.env.RUN_DB_TESTS !== "1" },
  async (t) => {
    const owner = `workflow-jobs-${randomUUID()}`;
    const outsider = `workflow-jobs-${randomUUID()}`;
    const runDate = "2035-01-15";
    try {
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
            "INSERT INTO brain_jobs (owner_id,kind,run_date,attempts,executor) VALUES ($1,'export','2035-01-18',2,'workflow') RETURNING id",
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
        "same-day GitHub success remains intact while Workflow executes a fresh pass",
        async () => {
          const cutoverDate = "2035-01-19";
          const legacy = await getPool().query(
            `INSERT INTO brain_jobs (owner_id,kind,run_date,status,attempts,executor,result,started_at,finished_at)
             VALUES ($1,'export',$2::date,'succeeded',1,'github',$3::jsonb,now(),now()) RETURNING *`,
            [
              owner,
              cutoverDate,
              JSON.stringify({ pushed: true, commit: "b".repeat(40) }),
            ],
          );
          assert.deepEqual(await dailyWorkflowStatus(owner, cutoverDate), []);
          const fresh = await beginWorkflowJob(
            owner,
            "export",
            cutoverDate,
            "cutover-run",
          );
          assert.notEqual(fresh.id, legacy.rows[0].id);
          assert.equal(fresh.executor, "workflow");
          assert.equal(fresh.status, "running");
          assert.equal(fresh.skip, false);
          assert.equal(fresh.attempts, 1);
          await finishWorkflowJob(owner, fresh.id, "cutover-run", "succeeded", {
            pushed: true,
            commit: "c".repeat(40),
          });
          const jobs = await dailyWorkflowStatus(owner, cutoverDate);
          assert.equal(jobs.length, 1);
          assert.equal(jobs[0].id, fresh.id);
          assert.equal(jobs[0].status, "succeeded");
          const historical = await getPool().query(
            "SELECT * FROM brain_jobs WHERE owner_id=$1 AND id=$2",
            [owner, legacy.rows[0].id],
          );
          assert.deepEqual(historical.rows, legacy.rows);
          await assert.rejects(
            finishWorkflowJob(
              owner,
              legacy.rows[0].id,
              "cutover-run",
              "succeeded",
            ),
            (error) =>
              error instanceof BrainError &&
              error.code === "WORKFLOW_RUN_SUPERSEDED",
          );
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
