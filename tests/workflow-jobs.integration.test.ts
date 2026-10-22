import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { HookNotFoundError } from "workflow/errors";
import { BrainError } from "../lib/brain/types";
import { getPool } from "../lib/db";
import {
  beginWorkflowJob,
  dailyWorkflowStatus,
  enabledWorkflowJobKinds,
  finishWorkflowJob,
  isTaskJobKind,
  queueWorkflowJobs,
  requeueTaskWorkflowJobs,
  WORKFLOW_JOB_KINDS,
  type WorkflowJobKind,
  workflowExportAttemptKey,
  workflowJobsComplete,
} from "../lib/maintenance/jobs";
import {
  type StartDeps,
  startNightlyMaintenance,
  startTaskMaintenance,
} from "../lib/maintenance/start";
import { tasksEnabledFor } from "../lib/tasks/feature";

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

test("task phases are nightly kinds only for an owner with the task manager on", () => {
  assert.deepEqual(WORKFLOW_JOB_KINDS, [
    "consolidation",
    "embeddings",
    "export",
    "task_keeper",
    "task_links",
  ]);
  assert.deepEqual(enabledWorkflowJobKinds(false), [
    "consolidation",
    "embeddings",
    "export",
  ]);
  assert.deepEqual(enabledWorkflowJobKinds(true), WORKFLOW_JOB_KINDS);
  assert.deepEqual(WORKFLOW_JOB_KINDS.filter(isTaskJobKind), [
    "task_keeper",
    "task_links",
  ]);
  const finished = (kinds: readonly WorkflowJobKind[]) =>
    kinds.map((kind) => ({ kind, status: "partial" as const }));
  const pages = enabledWorkflowJobKinds(false);
  assert.equal(workflowJobsComplete(finished(pages), pages), true);
  assert.equal(
    workflowJobsComplete(finished(pages), WORKFLOW_JOB_KINDS),
    false,
  );
  assert.equal(
    workflowJobsComplete(
      [
        ...finished(pages),
        { kind: "task_keeper", status: "succeeded" },
        { kind: "task_links", status: "failed" },
      ],
      WORKFLOW_JOB_KINDS,
    ),
    false,
  );
  assert.equal(
    workflowJobsComplete(finished(WORKFLOW_JOB_KINDS), WORKFLOW_JOB_KINDS),
    true,
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

      for (const status of ["partial", "succeeded"] as const) {
        await t.test(
          `manual rerun replaces ${status} once while cron and replay remain idempotent`,
          async () => {
            const date = status === "partial" ? "2035-02-01" : "2035-02-02";
            const original = await beginWorkflowJob(
              owner,
              "consolidation",
              date,
              "original",
            );
            await finishWorkflowJob(owner, original.id, "original", status, {
              writes: 0,
            });
            assert.equal(
              (await beginWorkflowJob(owner, "consolidation", date, "cron"))
                .skip,
              true,
            );
            await queueWorkflowJobs(owner, date, "original");
            const queued = (await dailyWorkflowStatus(owner, date)).find(
              (job) => job.kind === "consolidation",
            );
            assert.equal(queued?.status, "queued");
            assert.equal(queued?.workflowRunId, "original");
            assert.equal(queued?.attempts, 1);
            assert.equal(queued?.result, null);
            const manual = await beginWorkflowJob(
              owner,
              "consolidation",
              date,
              "manual",
              "original",
            );
            assert.equal(manual.skip, false);
            assert.equal(manual.attempts, 2);
            await queueWorkflowJobs(owner, date, "original");
            assert.equal(
              (await dailyWorkflowStatus(owner, date)).find(
                (job) => job.kind === "consolidation",
              )?.status,
              "running",
            );
            assert.equal(manual.result, null);
            assert.deepEqual(
              await beginWorkflowJob(
                owner,
                "consolidation",
                date,
                "manual",
                "original",
              ),
              manual,
            );
            await finishWorkflowJob(owner, manual.id, "manual", "succeeded", {
              writes: 0,
            });
            assert.equal(
              (
                await beginWorkflowJob(
                  owner,
                  "consolidation",
                  date,
                  "manual",
                  "original",
                )
              ).skip,
              true,
            );
            assert.equal(
              (
                await beginWorkflowJob(
                  owner,
                  "consolidation",
                  date,
                  "duplicate-manual",
                  "original",
                )
              ).skip,
              true,
            );
            await queueWorkflowJobs(owner, date, "original");
            assert.equal(
              (await dailyWorkflowStatus(owner, date)).find(
                (job) => job.kind === "consolidation",
              )?.status,
              "succeeded",
            );
            const next = await beginWorkflowJob(
              owner,
              "consolidation",
              date,
              "next-manual",
              "manual",
            );
            assert.equal(next.skip, false);
            assert.equal(next.attempts, 3);
          },
        );
      }

      await t.test(
        "a consolidation retry that changes pages also requeues the task phases",
        async () => {
          const date = "2035-01-23";
          const original = await initialFailedPass(date);
          const phases = [];
          for (const kind of ["task_keeper", "task_links"] as const) {
            const job = await beginWorkflowJob(
              owner,
              kind,
              date,
              "initial-run",
            );
            await finishWorkflowJob(
              owner,
              job.id,
              "initial-run",
              kind === "task_keeper" ? "succeeded" : "partial",
              { requests: 1, spendNano: 42_000, halt: null },
            );
            phases.push(job);
          }
          const retried = await beginWorkflowJob(
            owner,
            "consolidation",
            date,
            "corrected-run",
          );
          await finishWorkflowJob(
            owner,
            retried.id,
            "corrected-run",
            "succeeded",
            { writes: 1 },
          );
          const jobs = await dailyWorkflowStatus(owner, date);
          for (const previous of [
            original.embeddings,
            original.exported,
            ...phases,
          ]) {
            const queued = jobs.find((job) => job.id === previous.id);
            assert.equal(queued?.status, "queued");
            assert.equal(queued.workflowRunId, null);
            assert.equal(queued.result, null);
          }
          for (const kind of ["task_keeper", "task_links"] as const) {
            const refreshed = await beginWorkflowJob(
              owner,
              kind,
              date,
              "corrected-run",
            );
            assert.equal(refreshed.skip, false);
            assert.equal(refreshed.attempts, 2);
          }
        },
      );

      await t.test(
        "Run now requeues only today's task phases and never a running pass",
        async () => {
          const date = "2035-01-27";
          await queueWorkflowJobs(owner, date, undefined, WORKFLOW_JOB_KINDS);
          const queued = await dailyWorkflowStatus(owner, date);
          assert.deepEqual(
            queued.map((job) => job.kind),
            [...WORKFLOW_JOB_KINDS].sort(),
          );
          const completed = new Map<string, string>();
          for (const kind of WORKFLOW_JOB_KINDS) {
            const job = await beginWorkflowJob(owner, kind, date, "night-run");
            await finishWorkflowJob(
              owner,
              job.id,
              "night-run",
              kind === "task_links" ? "failed" : "succeeded",
              kind === "export"
                ? { pushed: true, commit: "c".repeat(40) }
                : kind === "consolidation"
                  ? { writes: 0 }
                  : { requests: 0 },
              kind === "task_links" ? "Phase failed." : undefined,
            );
            completed.set(kind, job.id);
          }
          const requeued = await requeueTaskWorkflowJobs(owner, date);
          assert.deepEqual(
            requeued.map((job) => [job.kind, job.status, job.attempts]),
            [
              ["task_keeper", "queued", 1],
              ["task_links", "queued", 1],
            ],
          );
          assert.ok(
            requeued.every(
              (job) =>
                job.id === completed.get(job.kind) &&
                job.workflowRunId === null &&
                job.result === null &&
                job.error === null,
            ),
          );
          const after = await dailyWorkflowStatus(owner, date);
          for (const job of after.filter((entry) => !isTaskJobKind(entry.kind)))
            assert.equal(job.status, "succeeded");
          const keeper = await beginWorkflowJob(
            owner,
            "task_keeper",
            date,
            "run-now",
          );
          assert.equal(keeper.skip, false);
          assert.equal(keeper.attempts, 2);
          const again = await requeueTaskWorkflowJobs(owner, date);
          assert.deepEqual(
            again.map((job) => [job.kind, job.status, job.workflowRunId]),
            [
              ["task_keeper", "running", "run-now"],
              ["task_links", "queued", null],
            ],
          );
          assert.equal(
            (await beginWorkflowJob(owner, "consolidation", date, "run-now"))
              .skip,
            true,
          );
          const fresh = await requeueTaskWorkflowJobs(owner, "2035-01-28");
          assert.deepEqual(
            fresh.map((job) => [job.kind, job.status, job.attempts]),
            [
              ["task_keeper", "queued", 0],
              ["task_links", "queued", 0],
            ],
          );
          assert.equal(
            (await dailyWorkflowStatus(owner, "2035-01-28")).length,
            2,
          );
          await assert.rejects(
            requeueTaskWorkflowJobs(owner, "2035-02-30"),
            (error) =>
              error instanceof BrainError && error.code === "INVALID_RUN_DATE",
          );
        },
      );

      await t.test("queueing validates explicit stage lists", async () => {
        await assert.rejects(
          queueWorkflowJobs(owner, "2035-02-03", undefined, []),
          (error) =>
            error instanceof BrainError && error.code === "INVALID_JOB_KIND",
        );
        await assert.rejects(
          queueWorkflowJobs(owner, "2035-02-03", undefined, [
            "harvest" as WorkflowJobKind,
          ]),
          (error) =>
            error instanceof BrainError && error.code === "INVALID_JOB_KIND",
        );
        assert.deepEqual(await dailyWorkflowStatus(owner, "2035-02-03"), []);
      });

      await t.test(
        "start queues all stages once without resetting completed work",
        async () => {
          const date = "2035-01-20";
          const kinds = enabledWorkflowJobKinds(false);
          await Promise.all([
            queueWorkflowJobs(owner, date, undefined, kinds),
            queueWorkflowJobs(owner, date, undefined, kinds),
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
          await queueWorkflowJobs(owner, date, undefined, kinds);
          const after = await dailyWorkflowStatus(owner, date);
          assert.equal(after.length, 3);
          assert.equal(
            after.find((entry) => entry.id === job.id)?.status,
            "succeeded",
          );
          // Without explicit stages a night has those of an owner with tasks off.
          await queueWorkflowJobs(owner, "2035-01-29");
          assert.deepEqual(
            (await dailyWorkflowStatus(owner, "2035-01-29")).map(
              (entry) => entry.kind,
            ),
            ["consolidation", "embeddings", "export"],
          );
        },
      );

      await t.test(
        "each owner's night and Run now follow that owner's own task manager setting",
        async () => {
          const date = "2035-03-01";
          const pages = enabledWorkflowJobKinds(false);
          const started: unknown[][] = [];
          // The real ledger and setting; only the Workflow runtime is faked.
          const deps: StartDeps = {
            start: async (_workflow, args) => {
              started.push(args);
              return { runId: `wrun-${started.length}` };
            },
            getHookByToken: async (token) => {
              throw new HookNotFoundError(token);
            },
            dailyWorkflowStatus,
            queueWorkflowJobs,
            requeueTaskWorkflowJobs,
            tasksEnabled: (ownerId) => tasksEnabledFor(ownerId),
            now: () => new Date(`${date}T20:00:00Z`),
          };
          const kinds = async (ownerId: string) =>
            (await dailyWorkflowStatus(ownerId, date)).map((job) => job.kind);
          const setTasks = (enabled: boolean) =>
            getPool().query(
              `INSERT INTO brain_task_settings (owner_id, enabled) VALUES ($1, $2)
               ON CONFLICT (owner_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
              [owner, enabled],
            );
          const disabled = (error: unknown) =>
            error instanceof BrainError &&
            error.code === "TASKS_DISABLED" &&
            error.status === 409;

          // The owner turns the task manager on; the outsider never had a row.
          await setTasks(true);
          assert.equal(await tasksEnabledFor(owner), true);
          assert.equal(await tasksEnabledFor(outsider), false);
          await startNightlyMaintenance(owner, "scheduled", deps);
          await startNightlyMaintenance(outsider, "scheduled", deps);
          assert.deepEqual(await kinds(owner), [...WORKFLOW_JOB_KINDS].sort());
          assert.deepEqual(await kinds(outsider), pages);
          assert.deepEqual(started, [
            [owner, date, undefined, { scope: "nightly", tasks: true }],
            [outsider, date, undefined, { scope: "nightly", tasks: false }],
          ]);

          // Run now is refused for the outsider and touches nothing.
          await assert.rejects(startTaskMaintenance(outsider, deps), disabled);
          assert.deepEqual(await kinds(outsider), pages);
          assert.equal(started.length, 2);

          // Turning it off hides the task phases without deleting their rows:
          // Run now is refused, and the night is complete with three stages.
          await setTasks(false);
          await assert.rejects(startTaskMaintenance(owner, deps), disabled);
          for (const kind of pages) {
            const job = await beginWorkflowJob(owner, kind, date, "night-run");
            await finishWorkflowJob(
              owner,
              job.id,
              "night-run",
              "succeeded",
              kind === "export"
                ? { pushed: true, commit: "e".repeat(40) }
                : { writes: 0 },
            );
          }
          assert.deepEqual(
            await startNightlyMaintenance(owner, "scheduled", deps),
            { completed: true, runDate: date },
          );
          assert.deepEqual(await kinds(owner), [...WORKFLOW_JOB_KINDS].sort());
          assert.equal(started.length, 2);

          // Turned back on, the pending task phases make the night incomplete.
          await setTasks(true);
          const night = await startNightlyMaintenance(owner, "scheduled", deps);
          assert.equal(night.completed, false);
          assert.deepEqual(started.at(-1), [
            owner,
            date,
            undefined,
            { scope: "nightly", tasks: true },
          ]);
          const runNow = await startTaskMaintenance(owner, deps);
          assert.equal(runNow.started, true);
          assert.deepEqual(started.at(-1), [
            owner,
            date,
            undefined,
            { scope: "tasks", tasks: true },
          ]);
          assert.deepEqual(await kinds(outsider), pages);
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
          const skippedExport = await beginWorkflowJob(
            owner,
            "export",
            "2035-01-19",
            "run-export-skipped",
          );
          await assert.rejects(
            finishWorkflowJob(
              owner,
              skippedExport.id,
              "run-export-skipped",
              "succeeded",
              { skipped: true, pushed: true },
            ),
            (error) =>
              error instanceof BrainError &&
              error.code === "EXPORT_NOT_PERSISTED",
          );
          const skipped = await finishWorkflowJob(
            owner,
            skippedExport.id,
            "run-export-skipped",
            "succeeded",
            { skipped: true },
          );
          assert.equal(skipped.status, "succeeded");
          assert.deepEqual(skipped.result, { skipped: true });
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
      await getPool().query(
        "DELETE FROM brain_task_settings WHERE owner_id=ANY($1::text[])",
        [[owner, outsider]],
      );
      await getPool().end();
    }
  },
);
