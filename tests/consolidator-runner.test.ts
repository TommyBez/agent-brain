import assert from "node:assert/strict";
import test from "node:test";
import { failureMessage } from "../lib/maintenance/consolidator/diagnostics";
import {
  type RunnerSteps,
  runConsolidation,
} from "../lib/maintenance/consolidator/runner";
import {
  buildSnapshot,
  createAnalysisTasks,
  pageEvidenceFingerprint,
} from "../lib/maintenance/consolidator/snapshot";
import type {
  AnalysisResult,
  ChangeSet,
  OperationPlan,
} from "../lib/maintenance/consolidator/types";
import { page } from "./helpers/consolidator";

const snapshot = buildSnapshot([page("a"), page("b"), page("c")]);
const tasks = createAnalysisTasks(snapshot);
const first = tasks[0];
const plan: OperationPlan = {
  id: "plan",
  kind: "deduplicate",
  findingIds: ["finding"],
  targetPageIds: ["a"],
  targetUnitIds: [snapshot.units[0].id],
  evidenceUnitIds: [snapshot.units[0].id],
  readSet: [{ pageId: "a", version: 1 }],
  goal: "Preserve facts once.",
};
const draft = { patches: [], links: [], noChange: false };
const changeSet: ChangeSet = { id: "change", plan, draft, changes: [] };
function analysis(taskId = first.id, supported = true): AnalysisResult {
  return {
    taskId,
    status: "complete",
    judgments: [],
    dependencies: [
      { pageId: "a", fingerprint: pageEvidenceFingerprint(snapshot.pages[0]) },
    ],
    findings: supported
      ? [
          {
            id: "finding",
            kind: "deduplicate",
            status: "supported",
            pageIds: ["a"],
            unitIds: [snapshot.units[0].id],
            evidenceUnitIds: [snapshot.units[0].id],
            goal: "Preserve facts once.",
          },
        ]
      : [],
  };
}
function fake(overrides: Partial<RunnerSteps> = {}) {
  const events: string[] = [];
  const queues: string[][] = [];
  const records: unknown[] = [];
  const steps: RunnerSteps = {
    snapshot: async () => {
      events.push("snapshot");
      return snapshot;
    },
    scan: async () => ({
      tasks: [first],
      cached: [],
      reused: 0,
      total: 1,
      remaining: 0,
    }),
    analyze: async () => {
      events.push("analyze");
      return analysis();
    },
    plan: async () => ({ selected: [plan], deferred: 0 }),
    draft: async () => {
      events.push("draft");
      return draft;
    },
    review: async () => ({
      changeSet,
      verification: { status: "accepted", defects: [], judgments: [] },
    }),
    apply: async () => {
      events.push("apply");
      return { status: "applied", pages: [snapshot.pages[0]] };
    },
    record: async (_key, value) => {
      records.push(value);
    },
    queue: async (ids) => {
      queues.push(ids);
    },
    ...overrides,
  };
  return { steps, events, queues, records };
}
const options = { taskBudget: 2000, repairs: 1 };

test("accepted writes happen automatically, with no global rescan in the same night", async () => {
  const run = fake();
  const result = await runConsolidation(run.steps, options);
  assert.equal(result.writes, 1);
  assert.deepEqual(run.events, ["snapshot", "analyze", "draft", "apply"]);
  assert.equal(result.stoppedBy, "changed");
  assert.deepEqual(run.queues, [[]]);
});

test("cached negative screening needs neither a model nor a planning step", async () => {
  const run = fake({
    scan: async () => ({
      tasks: [],
      cached: [],
      reused: 1,
      total: 1,
      remaining: 0,
    }),
    plan: async () => {
      throw new Error("No plans needed");
    },
  });
  const result = await runConsolidation(run.steps, options);
  assert.equal(result.reusedTasks, 1);
  assert.equal(result.remainingTasks, 0);
  assert.deepEqual(run.events, ["snapshot"]);
});

for (const halt of ["budget", "provider"] as const)
  test(`${halt} exhaustion stops dispatch and preserves pending work`, async () => {
    let calls = 0;
    const run = fake({
      scan: async () => ({
        tasks,
        cached: [],
        reused: 0,
        total: tasks.length,
        remaining: 0,
      }),
      analyze: async () => {
        calls++;
        return { halt };
      },
    });
    const result = await runConsolidation(run.steps, options);
    assert.equal(calls, 1);
    assert.equal(result.stoppedBy, halt);
    assert.equal(result.remainingTasks, tasks.length);
  });

test("budget exhaustion during verification never writes or caches a terminal rejection", async () => {
  const run = fake({ review: async () => ({ halt: "budget" }) });
  const result = await runConsolidation(run.steps, options);
  assert.equal(result.writes, 0);
  assert.equal(result.stoppedBy, "budget");
  assert.equal(run.records.length, 0);
  assert.deepEqual(run.queues, [[]]);
});

test("one bounded repair is followed by a fresh verification", async () => {
  let reviews = 0;
  const attempts: number[] = [];
  const run = fake({
    draft: async (_snapshot, _plan, attempt) => {
      attempts.push(attempt);
      return draft;
    },
    review: async () => ({
      changeSet,
      verification: {
        status: ++reviews === 1 ? "rejected" : "accepted",
        defects: ["Preserve source."],
        judgments: [],
      },
    }),
  });
  const result = await runConsolidation(run.steps, options);
  assert.deepEqual(attempts, [0, 1]);
  assert.equal(result.writes, 1);
});

test("uncertain verification is recorded without global evidence expansion or human work", async () => {
  const run = fake({
    review: async () => ({
      changeSet,
      verification: {
        status: "uncertain",
        defects: ["Unsupported correction."],
        judgments: [],
      },
    }),
  });
  const result = await runConsolidation(run.steps, options);
  assert.equal(result.writes, 0);
  assert.equal(result.unresolved, 1);
  assert.equal(result.remainingTasks, 0);
  assert.equal(run.records.length, 1);
});

test("a write defers subsequent comparisons involving that page", async () => {
  let calls = 0;
  const pair = tasks.find(
    (task) => task.kind === "pair" && task.pageIds.includes("a"),
  );
  assert.ok(pair);
  const run = fake({
    scan: async () => ({
      tasks: [first, pair],
      cached: [],
      reused: 0,
      total: 2,
      remaining: 0,
    }),
    analyze: async () => {
      calls++;
      return analysis();
    },
  });
  const result = await runConsolidation(run.steps, options);
  assert.equal(calls, 1);
  assert.equal(result.remainingTasks, 2);
});

test("three consecutive exhausted gateway failures stop dispatch", async () => {
  let calls = 0;
  const run = fake({
    scan: async () => ({
      tasks,
      cached: [],
      reused: 0,
      total: tasks.length,
      remaining: 0,
    }),
    analyze: async () => {
      calls++;
      throw new Error(
        failureMessage({
          category: "gateway",
          code: "http_503",
          retryable: true,
        }),
      );
    },
  });
  const result = await runConsolidation(run.steps, options);
  assert.equal(calls, 3);
  assert.equal(result.errors, 3);
  assert.equal(result.stoppedBy, "provider");
  assert.equal(result.remainingTasks, tasks.length);
});

test("incomplete analysis remains queued and cannot be mistaken for a negative", async () => {
  const run = fake({
    analyze: async () => ({ ...analysis(), status: "incomplete" }),
  });
  const result = await runConsolidation(run.steps, options);
  assert.equal(result.writes, 0);
  assert.equal(result.remainingTasks, 1);
});

test("queue completion is one bounded delta and leaves unscheduled tasks pending", async () => {
  const selected = tasks.slice(0, 2);
  const run = fake({
    scan: async () => ({
      tasks: selected,
      cached: [],
      reused: 100,
      total: 5102,
      remaining: 5000,
    }),
    analyze: async (_snapshot, task) => analysis(task.id, false),
  });
  const result = await runConsolidation(run.steps, options);
  assert.deepEqual(run.queues, [selected.map((task) => task.id)]);
  assert.equal(result.remainingTasks, 5000);
  assert.equal(result.reusedTasks, 100);
  assert.equal(result.stoppedBy, "limit");
});

for (const stage of ["analyze", "draft", "review", "apply"] as const) {
  test(`isolated ${stage} failure leaves failed task queued and processes independent work`, async () => {
    let calls = 0;
    const run = fake({
      scan: async () => ({
        tasks,
        cached: [],
        reused: 0,
        total: tasks.length,
        remaining: 0,
      }),
      analyze: async (_snapshot, task) => ({
        ...analysis(task.id, task.id === first.id),
        dependencies: task.pageIds.map((pageId) => ({
          pageId,
          fingerprint: "test",
        })),
      }),
    });
    if (stage === "analyze") {
      const original = run.steps.analyze;
      run.steps.analyze = async (snapshot, task) => {
        if (calls++ === 0)
          throw new Error("private content must not be logged");
        return original(snapshot, task);
      };
    } else {
      run.steps[stage] = async () => {
        throw new Error("private content must not be logged");
      };
    }
    const result = await runConsolidation(run.steps, options);
    assert.equal(result.errors, 1);
    assert.equal(result.status, "partial");
    assert.equal(result.stoppedBy, "incomplete");
    assert.ok(result.evaluatedTasks > 1);
    assert.ok(!run.queues[0].includes(first.id));
    assert.ok(run.queues[0].length > 0);
    assert.doesNotMatch(JSON.stringify(run.records), /private content/);
    assert.ok(JSON.stringify(run.records).includes('"stage"'));
  });
}

test("successful tasks reset the consecutive gateway failure counter", async () => {
  let calls = 0;
  const run = fake({
    scan: async () => ({
      tasks,
      cached: [],
      reused: 0,
      total: tasks.length,
      remaining: 0,
    }),
    analyze: async (_snapshot, task) => {
      if (calls++ % 2 === 0)
        throw new Error(
          failureMessage({
            category: "gateway",
            code: "http_503",
            retryable: true,
          }),
        );
      return analysis(task.id, false);
    },
  });
  const result = await runConsolidation(run.steps, options);
  assert.equal(calls, tasks.length);
  assert.equal(result.stoppedBy, "incomplete");
});

test("invalid Jev responses do not trip the Gateway outage cutoff", async () => {
  let calls = 0;
  const run = fake({
    scan: async () => ({
      tasks,
      cached: [],
      reused: 0,
      total: tasks.length,
      remaining: 0,
    }),
    analyze: async () => {
      calls++;
      throw new Error(
        failureMessage({
          category: "jev",
          code: "choice_mass",
          retryable: false,
        }),
      );
    },
  });
  const result = await runConsolidation(run.steps, options);
  assert.equal(calls, tasks.length);
  assert.equal(result.errors, tasks.length);
  assert.equal(result.remainingTasks, tasks.length);
  assert.equal(result.stoppedBy, "incomplete");
});

test("incomplete analysis interrupts the consecutive Gateway failure streak", async () => {
  let calls = 0;
  const run = fake({
    scan: async () => ({
      tasks,
      cached: [],
      reused: 0,
      total: tasks.length,
      remaining: 0,
    }),
    analyze: async (_snapshot, task) => {
      const index = calls++;
      if (index === 1)
        return { ...analysis(task.id, false), status: "incomplete" };
      if ([0, 2, 3].includes(index))
        throw new Error(
          failureMessage({
            category: "gateway",
            code: "http_503",
            retryable: true,
          }),
        );
      return analysis(task.id, false);
    },
  });
  const result = await runConsolidation(run.steps, options);
  assert.equal(calls, tasks.length);
  assert.equal(result.stoppedBy, "incomplete");
  assert.equal(result.errors, 4);
  assert.equal(result.remainingTasks, 4);
  assert.deepEqual(run.queues, [tasks.slice(4).map((task) => task.id)]);
});
