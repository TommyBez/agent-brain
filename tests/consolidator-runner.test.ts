import assert from "node:assert/strict";
import test from "node:test";
import {
  CapacityError,
  capacityVerification,
} from "../lib/maintenance/consolidator/capacity";
import { selectIndependentPlans } from "../lib/maintenance/consolidator/planner";
import {
  type RunnerSteps,
  runConsolidation,
} from "../lib/maintenance/consolidator/runner";
import type {
  AnalysisTask,
  ChangeSet,
  DecisionRecord,
  OperationPlan,
  Snapshot,
} from "../lib/maintenance/consolidator/types";

const snapshot: Snapshot = {
  id: "s",
  createdAt: "2026-09-25",
  pages: [],
  units: [],
};
const task: AnalysisTask = {
  id: "t",
  kind: "document",
  pageIds: ["a"],
  unitIds: ["u"],
};
const plan: OperationPlan = {
  id: "op",
  kind: "deduplicate",
  findingIds: ["f"],
  targetPageIds: ["a"],
  targetUnitIds: ["u"],
  evidenceUnitIds: ["u"],
  readSet: [{ pageId: "a", version: 1 }],
  goal: "Deduplicate.",
};
const draft = { patches: [], links: [], noChange: false };
const changeSet: ChangeSet = { id: "change", plan, draft, changes: [] };
const accepted = {
  changeSet,
  verification: { status: "accepted" as const, defects: [], judgments: [] },
};
const options = {
  maxWaves: 4,
  taskBudget: 100,
  concurrency: 2,
  repairs: 1,
  expansions: 2,
};

function fake(overrides: Partial<RunnerSteps> = {}) {
  const records: { key: string; value: unknown }[] = [];
  let writes = 0;
  const steps: RunnerSteps = {
    snapshot: async () => snapshot,
    scan: async () => ({ tasks: [task], cached: [], total: 1, remaining: 0 }),
    analyze: async () => ({
      taskId: task.id,
      findings: [],
      judgments: [],
      status: "complete",
    }),
    plan: async () => ({ selected: writes === 0 ? [plan] : [], deferred: 0 }),
    draft: async () => draft,
    review: async () => accepted,
    expand: async () => null,
    apply: async () => {
      writes++;
      return { status: "applied", pages: [] };
    },
    record: async (key, value) => {
      records.push({ key, value });
    },
    ...overrides,
  };
  return { steps, records, writes: () => writes };
}

test("accepted proposals automatically reach the writer and complete a stable pass", async () => {
  const run = fake();
  const result = await runConsolidation(run.steps, options);
  assert.equal(result.status, "succeeded");
  assert.equal(result.stoppedBy, "stable");
  assert.equal(result.waves, 2);
  assert.equal(run.writes(), 1);
  assert.equal("mode" in result, false);
  assert.equal("previews" in result, false);
  const decision = run.records.find((record) => record.key === "decision:op")
    ?.value as { status: string };
  assert.equal(decision.status, "applied");
});

test("successful apply takes a fresh snapshot and reaches a healthy unchanged pass", async () => {
  let snapshots = 0;
  const run = fake({
    snapshot: async () => ({ ...snapshot, id: String(++snapshots) }),
    plan: async () => ({
      selected: snapshots === 1 ? [plan] : [],
      deferred: 0,
    }),
  });
  const result = await runConsolidation(run.steps, options);
  assert.equal(run.writes(), 1);
  assert.equal(snapshots, 2);
  assert.equal(result.stoppedBy, "stable");
});

test("empty first expansion tier still reaches unlinked corpus evidence", async () => {
  const depths: number[] = [];
  let reviews = 0;
  const expanded = {
    ...plan,
    readSet: [...plan.readSet, { pageId: "source", version: 7 }],
  };
  const run = fake({
    review: async (_snapshot, received) => {
      reviews++;
      return received.readSet.length > 1
        ? accepted
        : {
            changeSet,
            verification: {
              status: "uncertain",
              defects: ["Evidence insufficient."],
              judgments: [],
            },
          };
    },
    expand: async (_snapshot, _plan, depth) => {
      depths.push(depth);
      return depth === 2 ? expanded : null;
    },
  });
  const result = await runConsolidation(run.steps, options);
  assert.deepEqual(depths, [1, 2]);
  assert.equal(reviews, 2);
  assert.equal(result.status, "succeeded");
  assert.equal(run.writes(), 1);
  const record = run.records.find((record) => record.key === "decision:op:s")
    ?.value as { evidenceVersions: unknown };
  assert.deepEqual(record.evidenceVersions, expanded.readSet);
});

test("rejected draft gets one bounded repair and no repeated favorable rerolls", async () => {
  const attempts: number[] = [];
  const run = fake({
    draft: async (_snapshot, _plan, attempt) => {
      attempts.push(attempt);
      return draft;
    },
    review: async () => ({
      changeSet,
      verification: {
        status: "rejected",
        defects: ["Lost qualifier."],
        judgments: [],
      },
    }),
  });
  const result = await runConsolidation(run.steps, options);
  assert.deepEqual(attempts, [0, 1]);
  assert.equal(result.rejected, 1);
  assert.equal(run.writes(), 0);
});

test("persistent uncertainty exhausts bounded evidence expansion without a write", async () => {
  const depths: number[] = [];
  const run = fake({
    review: async () => ({
      changeSet,
      verification: {
        status: "uncertain",
        defects: ["Evidence insufficient."],
        judgments: [],
      },
    }),
    expand: async (_snapshot, _plan, depth) => {
      depths.push(depth);
      return null;
    },
  });
  const result = await runConsolidation(run.steps, options);
  assert.deepEqual(depths, [1, 2]);
  assert.equal(result.unresolved, 1);
  assert.equal(result.stoppedBy, "stable");
  assert.equal(run.writes(), 0);
  const decision = run.records.find((record) => record.key === "decision:op:s")
    ?.value as { status: string };
  assert.equal(decision.status, "uncertain");
});

test("an empty evidence search cannot cache uncertainty across a later source addition", async () => {
  const records = new Map<string, DecisionRecord>();
  let current = snapshot;
  let searches = 0;
  const run = fake({
    snapshot: async () => current,
    plan: async () => ({
      selected: records.has(`decision:${plan.id}:${current.id}`) ? [] : [plan],
      deferred: 0,
    }),
    review: async () => ({
      changeSet,
      verification: {
        status: "uncertain",
        defects: ["Evidence insufficient."],
        judgments: [],
      },
    }),
    expand: async () => {
      searches++;
      return null;
    },
    record: async (key, value) => {
      if (key.startsWith("decision:"))
        records.set(key, value as DecisionRecord);
    },
  });
  await runConsolidation(run.steps, options);
  assert.equal(searches, 2);
  assert.ok(records.has("decision:op:s"));
  await runConsolidation(run.steps, options);
  assert.equal(searches, 2, "unchanged corpus reuses the terminal search");
  current = { ...snapshot, id: "with-new-source" };
  await runConsolidation(run.steps, options);
  assert.equal(searches, 4, "a new corpus permits the evidence search again");
  assert.ok(records.has("decision:op:with-new-source"));
});

test("missing verification coverage is operational partial, never a cached semantic rejection", async () => {
  const run = fake({
    review: async () => ({
      changeSet,
      verification: {
        status: "uncertain",
        incomplete: true,
        defects: ["Provider omitted an applicable judgment."],
        judgments: [],
      },
    }),
  });
  const result = await runConsolidation(run.steps, options);
  assert.equal(result.status, "partial");
  assert.equal(result.errors, 1);
  const decision = run.records.find((record) => record.key === "decision:op");
  assert.ok(decision);
  assert.equal((decision.value as DecisionRecord).status, "error");
  assert.equal(result.capacityLimited, 0);
  assert.equal(run.writes(), 0);
});

test("deterministic capacity drains deferred useful plans and stays terminal on unchanged evidence", async () => {
  const useful = { ...plan, id: "useful-after-capacity" };
  const decisions = new Map<string, DecisionRecord>();
  const reviewed: string[] = [];
  const drafted: string[] = [];
  let expansions = 0;
  const run = fake({
    plan: async () => {
      const remaining = [plan, useful].filter(
        (candidate) => !decisions.has(candidate.id),
      );
      const selected = selectIndependentPlans(remaining);
      return {
        selected: selected.selected,
        deferred: selected.deferred.length,
        capacityLimited: [...decisions.values()].filter(
          (decision) => decision.reason === "capacity",
        ).length,
      };
    },
    draft: async (_snapshot, candidate) => {
      drafted.push(candidate.id);
      return draft;
    },
    review: async (_snapshot, candidate) => {
      reviewed.push(candidate.id);
      return candidate.id === plan.id
        ? {
            changeSet,
            verification: capacityVerification({
              stage: "verification",
              requiredCharacters: 110_000,
              limitCharacters: 100_000,
            }),
          }
        : accepted;
    },
    expand: async () => {
      expansions++;
      return null;
    },
  });
  const record = run.steps.record;
  run.steps.record = async (key, value) => {
    if (key.startsWith("decision:"))
      decisions.set(
        (value as DecisionRecord).operationId,
        value as DecisionRecord,
      );
    await record(key, value);
  };
  const first = await runConsolidation(run.steps, options);
  assert.equal(first.status, "partial");
  assert.equal(first.stoppedBy, "incomplete");
  assert.equal(first.errors, 0);
  assert.equal(first.capacityLimited, 1);
  assert.equal(first.unresolved, 1);
  assert.equal(run.writes(), 1);
  assert.equal(expansions, 0);
  assert.deepEqual(reviewed, [plan.id, useful.id]);
  assert.deepEqual(drafted, [plan.id, useful.id]);
  assert.equal(decisions.get(plan.id)?.status, "uncertain");
  assert.equal(decisions.get(plan.id)?.reason, "capacity");
  assert.deepEqual(decisions.get(plan.id)?.evidenceVersions, plan.readSet);
  const second = await runConsolidation(run.steps, options);
  assert.equal(second.status, "partial");
  assert.equal(second.errors, 0);
  assert.equal(second.capacityLimited, 1);
  assert.equal(second.unresolved, 1);
  assert.equal(second.proposed, 0);
  assert.equal(run.writes(), 1);
  assert.deepEqual(reviewed, [plan.id, useful.id]);
  assert.match(second.report, /1 capacity-limited operations/);
});

test("editor capacity survives a serialized draft outcome without being counted as a provider error", async () => {
  const capacity = {
    stage: "editor" as const,
    requiredCharacters: 110_000,
    limitCharacters: 100_000,
  };
  const run = fake({
    draft: async () => JSON.parse(JSON.stringify({ capacity })),
    review: async () => {
      throw new Error("Capacity must stop before verification");
    },
  });
  const result = await runConsolidation(run.steps, options);
  assert.equal(result.status, "partial");
  assert.equal(result.errors, 0);
  assert.equal(result.capacityLimited, 1);
  assert.equal(result.unresolved, 1);
  const decision = run.records.find((record) => record.key === "decision:op");
  assert.ok(decision);
  assert.equal((decision.value as DecisionRecord).reason, "capacity");
  assert.deepEqual(
    (decision.value as DecisionRecord).verification?.capacity,
    capacity,
  );
});

test("a typed materialization limit is terminal while an actual provider failure remains retryable", async () => {
  const capacityRun = fake({
    review: async () => {
      throw new CapacityError("materialization", 100_001, 100_000);
    },
  });
  const capacityResult = await runConsolidation(capacityRun.steps, options);
  assert.equal(capacityResult.errors, 0);
  assert.equal(capacityResult.capacityLimited, 1);
  const failedRun = fake({
    review: async () => {
      throw new Error("Provider response invalid");
    },
  });
  const failedResult = await runConsolidation(failedRun.steps, options);
  assert.equal(failedResult.errors, 1);
  assert.equal(failedResult.capacityLimited, 0);
  const decision = failedRun.records.find(
    (record) => record.key === "decision:op",
  );
  assert.ok(decision);
  assert.equal((decision.value as DecisionRecord).status, "error");
});

test("provider errors and unexamined tasks cannot report a successful no-op", async () => {
  const run = fake({
    analyze: async () => {
      throw new Error("Provider unavailable");
    },
    plan: async () => ({ selected: [], deferred: 0 }),
    scan: async () => ({ tasks: [task], cached: [], total: 4, remaining: 3 }),
  });
  const result = await runConsolidation(run.steps, options);
  assert.equal(result.status, "partial");
  assert.equal(result.remainingTasks, 4);
  assert.equal(result.errors, 1);
});

test("declined first plan does not hide deferred overlapping operations", async () => {
  let planning = 0;
  const run = fake({
    plan: async () => ({
      selected: ++planning < 3 ? [{ ...plan, id: `op-${planning}` }] : [],
      deferred: planning === 1 ? 1 : 0,
    }),
    draft: async () => ({ ...draft, noChange: true }),
  });
  const result = await runConsolidation(run.steps, options);
  assert.equal(planning, 2);
  assert.equal(result.waves, 1);
  assert.equal(result.stoppedBy, "stable");
  assert.equal(run.writes(), 0);
});

test("shared-read uncertain plans drain before a valid write, with every write followed by a fresh scan", async () => {
  let snapshots = 0;
  let scans = 0;
  let analyses = 0;
  const terminal = new Set<string>();
  const reviewed: { snapshotId: string; planId: string }[] = [];
  const uncertain = {
    ...plan,
    id: "uncertain-shared-read",
    kind: "add_link" as const,
  };
  const useful = {
    ...plan,
    id: "useful-shared-read",
    kind: "add_link" as const,
  };
  const run = fake({
    snapshot: async () => ({ ...snapshot, id: `revision-${++snapshots}` }),
    scan: async () => {
      scans++;
      return { tasks: [task], cached: [], total: 1, remaining: 0 };
    },
    analyze: async () => {
      analyses++;
      return {
        taskId: task.id,
        findings: [],
        judgments: [],
        status: "complete",
      };
    },
    plan: async (current) => {
      const candidates =
        current.id === "revision-1"
          ? [plan]
          : current.id === "revision-2"
            ? [uncertain, useful].filter(
                (candidate) =>
                  !terminal.has(candidate.id) &&
                  !terminal.has(`${candidate.id}:${current.id}`),
              )
            : [];
      const selected = selectIndependentPlans(candidates);
      return {
        selected: selected.selected,
        deferred: selected.deferred.length,
      };
    },
    review: async (current, received) => {
      reviewed.push({ snapshotId: current.id, planId: received.id });
      return received.id === uncertain.id
        ? {
            changeSet,
            verification: {
              status: "uncertain",
              defects: ["Unsupported relation."],
              judgments: [],
            },
          }
        : accepted;
    },
  });
  const record = run.steps.record;
  run.steps.record = async (key, value) => {
    if (
      key.startsWith("decision:") &&
      (value as { status: string }).status === "uncertain"
    )
      terminal.add(key.slice("decision:".length));
    await record(key, value);
  };
  const result = await runConsolidation(run.steps, {
    ...options,
    maxWaves: 3,
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.stoppedBy, "stable");
  assert.equal(result.waves, 3);
  assert.equal(snapshots, 3);
  assert.equal(scans, 3);
  assert.equal(analyses, 3);
  assert.equal(run.writes(), 2);
  assert.deepEqual(reviewed, [
    { snapshotId: "revision-1", planId: plan.id },
    { snapshotId: "revision-2", planId: uncertain.id },
    { snapshotId: "revision-2", planId: useful.id },
  ]);
});

test("a technical error stops deferred draining on the unchanged snapshot", async () => {
  let planning = 0;
  const run = fake({
    plan: async () => {
      planning++;
      return { selected: [plan], deferred: 1 };
    },
    draft: async () => {
      throw new Error("Provider unavailable.");
    },
  });
  const result = await runConsolidation(run.steps, options);
  assert.equal(result.status, "partial");
  assert.equal(result.stoppedBy, "incomplete");
  assert.equal(result.errors, 1);
  assert.equal(planning, 1);
  assert.equal(run.writes(), 0);
});

test("a real write defers dependent work until a new snapshot even when capacity remains", async () => {
  let snapshots = 0;
  const planningSnapshots: number[] = [];
  const run = fake({
    snapshot: async () => ({ ...snapshot, id: String(++snapshots) }),
    plan: async () => {
      planningSnapshots.push(snapshots);
      return snapshots === 1
        ? { selected: [plan], deferred: 2 }
        : { selected: [], deferred: 0 };
    },
  });
  const result = await runConsolidation(run.steps, options);
  assert.equal(result.status, "succeeded");
  assert.equal(result.waves, 2);
  assert.deepEqual(planningSnapshots, [1, 2]);
  assert.equal(run.writes(), 1);
});

test("automatic consolidation continues beyond the first independent batch", async () => {
  let planning = 0;
  const run = fake({
    plan: async () => {
      planning++;
      return {
        selected: planning < 3 ? [{ ...plan, id: `op-${planning}` }] : [],
        deferred: planning === 1 ? 1 : 0,
      };
    },
  });
  const result = await runConsolidation(run.steps, options);
  assert.equal(result.status, "succeeded");
  assert.equal(result.stoppedBy, "stable");
  assert.equal(result.waves, 3);
  assert.equal(planning, 3);
  assert.equal(run.writes(), 2);
});

test("pending post-write verification at wave limit remains partial", async () => {
  const run = fake();
  const result = await runConsolidation(run.steps, {
    ...options,
    maxWaves: 1,
  });
  assert.equal(result.status, "partial");
  assert.equal(result.stoppedBy, "limit");
});
