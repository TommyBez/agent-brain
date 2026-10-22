import assert from "node:assert/strict";
import test from "node:test";
import { HookNotFoundError } from "workflow/errors";
import type { WorkflowJob, WorkflowJobKind } from "../lib/maintenance/jobs";
import {
  type StartDeps,
  startNightlyMaintenance,
  startTaskMaintenance,
} from "../lib/maintenance/start";

// "Run now" for the task phases and the nightly start, with the Workflow
// runtime and the job ledger faked: which run is reused, what is requeued and
// what a new run is asked to do.

const OWNER = "owner-start-test";
const TODAY = "2026-10-21";

type Status = WorkflowJob["status"];

function harness(
  options: {
    tasks?: boolean;
    hook?: { runId: string; metadata?: unknown } | null;
    jobs?: Partial<Record<WorkflowJobKind, Status>>;
  } = {},
) {
  const calls = {
    started: [] as unknown[][],
    queued: [] as unknown[][],
    requeued: [] as unknown[][],
  };
  const jobs = (): WorkflowJob[] =>
    Object.entries(options.jobs ?? {}).map(
      ([kind, status]) =>
        ({
          kind,
          status,
          workflowRunId: kind === "consolidation" ? "wrun-earlier" : null,
        }) as unknown as WorkflowJob,
    );
  const deps: StartDeps = {
    env: { TASKS_ENABLED: options.tasks === false ? "false" : "true" },
    now: () => new Date(`${TODAY}T20:00:00Z`),
    start: async (_workflow, args) => {
      calls.started.push(args);
      return { runId: `wrun-${calls.started.length}` };
    },
    getHookByToken: async (token) => {
      assert.equal(token, `brain-nightly:${OWNER}`);
      if (!options.hook) throw new HookNotFoundError(token);
      return options.hook;
    },
    dailyWorkflowStatus: async (ownerId, runDate) => {
      assert.deepEqual([ownerId, runDate], [OWNER, TODAY]);
      return jobs();
    },
    queueWorkflowJobs: async (...args) => {
      calls.queued.push(args);
    },
    requeueTaskWorkflowJobs: async (...args) => {
      calls.requeued.push(args);
      return [];
    },
  };
  return { deps, calls };
}

const nightly = (runDate = TODAY) => ({
  runId: "wrun-night",
  metadata: { runDate, scope: "nightly" },
});
const tasksRun = {
  runId: "wrun-tasks",
  metadata: { runDate: TODAY, scope: "tasks" },
};

test("Run now without an active run requeues only the task phases and starts a tasks-scope run", async () => {
  const { deps, calls } = harness();
  const result = await startTaskMaintenance(OWNER, deps);
  assert.deepEqual(result, {
    runId: "wrun-1",
    runDate: TODAY,
    completed: false,
    started: true,
  });
  assert.deepEqual(calls.requeued, [[OWNER, TODAY]]);
  assert.deepEqual(calls.queued, []);
  assert.deepEqual(calls.started, [
    [OWNER, TODAY, undefined, { scope: "tasks", tasks: true }],
  ]);
});

test("Run now reuses today's active run while a task phase is queued or running", async () => {
  for (const status of ["queued", "running"] as const)
    for (const hook of [nightly(), tasksRun]) {
      const { deps, calls } = harness({
        hook,
        jobs: {
          consolidation: "succeeded",
          embeddings: "running",
          task_keeper: status,
          task_links: "queued",
        },
      });
      const result = await startTaskMaintenance(OWNER, deps);
      assert.deepEqual(result, {
        runId: hook.runId,
        runDate: TODAY,
        completed: false,
        started: false,
      });
      assert.deepEqual(calls.requeued, []);
      assert.deepEqual(calls.started, []);
    }
});

test("Run now starts a new tasks run when today's run finished its task phases or is another day's", async () => {
  for (const options of [
    {
      hook: nightly(),
      jobs: {
        consolidation: "running",
        task_keeper: "succeeded",
        task_links: "partial",
      } as const,
    },
    {
      hook: tasksRun,
      jobs: { task_keeper: "failed", task_links: "failed" } as const,
    },
    { hook: nightly("2026-10-20"), jobs: { task_keeper: "queued" } as const },
  ]) {
    const { deps, calls } = harness(options);
    const result = await startTaskMaintenance(OWNER, deps);
    assert.equal(result.started, true);
    assert.equal(result.runId, "wrun-1");
    assert.deepEqual(calls.requeued, [[OWNER, TODAY]]);
    assert.deepEqual(calls.started[0][3], { scope: "tasks", tasks: true });
  }
});

test("Run now is refused while the task release is off", async () => {
  const { deps, calls } = harness({ tasks: false });
  await assert.rejects(startTaskMaintenance(OWNER, deps), {
    code: "TASKS_DISABLED",
    status: 409,
  });
  assert.deepEqual([calls.requeued, calls.started], [[], []]);
});

test("a night reuses today's nightly run but never defers to a tasks-scope run", async () => {
  const reused = harness({
    hook: nightly(),
    jobs: { consolidation: "running" },
  });
  assert.deepEqual(
    await startNightlyMaintenance(OWNER, "scheduled", reused.deps),
    {
      runId: "wrun-night",
      runDate: TODAY,
      completed: false,
    },
  );
  assert.deepEqual(reused.calls.started, []);

  // A task-only "Run now" holds the lock: the scheduled night queues its own run.
  const behind = harness({
    hook: tasksRun,
    jobs: { task_keeper: "running", task_links: "queued" },
  });
  const result = await startNightlyMaintenance(OWNER, "scheduled", behind.deps);
  assert.deepEqual(result, {
    runId: "wrun-1",
    runDate: TODAY,
    completed: false,
  });
  assert.equal(behind.calls.queued.length, 1);
  assert.deepEqual(behind.calls.started, [
    [OWNER, TODAY, undefined, { scope: "nightly", tasks: true }],
  ]);
  const [, , rerunFrom, kinds] = behind.calls.queued[0];
  assert.equal(rerunFrom, undefined);
  assert.deepEqual(kinds, [
    "consolidation",
    "embeddings",
    "export",
    "task_keeper",
    "task_links",
  ]);
});

test("a completed night is not started again; a manual night reruns consolidation", async () => {
  const done = harness({
    jobs: {
      consolidation: "succeeded",
      embeddings: "succeeded",
      export: "partial",
      task_keeper: "succeeded",
      task_links: "partial",
    },
  });
  assert.deepEqual(
    await startNightlyMaintenance(OWNER, "scheduled", done.deps),
    {
      completed: true,
      runDate: TODAY,
    },
  );
  assert.deepEqual([done.calls.queued, done.calls.started], [[], []]);

  // Without task phases done the night is incomplete while tasks are on…
  const pending = harness({
    jobs: {
      consolidation: "succeeded",
      embeddings: "succeeded",
      export: "succeeded",
    },
  });
  const result = await startNightlyMaintenance(
    OWNER,
    "scheduled",
    pending.deps,
  );
  assert.equal(result.completed, false);
  // …and complete with the release off, whose night has three stages.
  const off = harness({
    tasks: false,
    jobs: {
      consolidation: "succeeded",
      embeddings: "succeeded",
      export: "succeeded",
    },
  });
  assert.equal(
    (await startNightlyMaintenance(OWNER, "scheduled", off.deps)).completed,
    true,
  );

  const manual = harness({
    jobs: { consolidation: "succeeded" },
    tasks: false,
  });
  await startNightlyMaintenance(OWNER, "manual", manual.deps);
  assert.deepEqual(manual.calls.queued, [
    [OWNER, TODAY, "wrun-earlier", ["consolidation", "embeddings", "export"]],
  ]);
  assert.deepEqual(manual.calls.started, [
    [OWNER, TODAY, "wrun-earlier", { scope: "nightly", tasks: false }],
  ]);
});
