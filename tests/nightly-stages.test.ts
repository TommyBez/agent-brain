import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowJobKind } from "../lib/maintenance/jobs";
import {
  type NightlyOptions,
  runNightlyStages,
  type StageOutcome,
} from "../lib/maintenance/nightly-stages";

/** Export finishes only after `releaseAfter`, proving it runs beside indexing. */
function recorder(
  outcomes: Partial<Record<WorkflowJobKind, string>> = {},
  releaseAfter: WorkflowJobKind = "task_links",
) {
  const events: string[] = [];
  let release = () => {};
  const exported = new Promise<void>((done) => {
    release = done;
  });
  const run = async (kind: WorkflowJobKind): Promise<StageOutcome> => {
    events.push(`start:${kind}`);
    if (kind === "export") await exported;
    events.push(`end:${kind}`);
    if (kind === releaseAfter) release();
    const status = outcomes[kind] ?? "succeeded";
    if (status === "throw") throw new Error("bookkeeping");
    return { status };
  };
  /** Asserts the event order a → b → …; unrelated events may interleave. */
  const ordered = (...sequence: string[]) => {
    const positions = sequence.map((event) => events.indexOf(event));
    assert.ok(
      positions.every((position) => position >= 0),
      `missing ${sequence}`,
    );
    for (let i = 1; i < positions.length; i++)
      assert.ok(
        positions[i - 1] < positions[i],
        `${sequence[i - 1]} before ${sequence[i]}`,
      );
  };
  return { run, events, ordered };
}

test("the night runs consolidation, then embeddings → task_keeper → task_links beside export", async () => {
  const { run, events, ordered } = recorder();
  const { failed, jobs } = await runNightlyStages(run, { tasks: true });
  assert.equal(failed, false);
  assert.deepEqual(Object.keys(jobs).sort(), [
    "consolidation",
    "embeddings",
    "export",
    "task_keeper",
    "task_links",
  ]);
  assert.equal(events.length, 10);
  ordered(
    "end:consolidation",
    "start:embeddings",
    "end:embeddings",
    "start:task_keeper",
    "end:task_keeper",
    "start:task_links",
    "end:task_links",
    "end:export",
  );
  // Export starts with indexing, not after the task phases.
  ordered("end:consolidation", "start:export", "start:task_keeper");
});

test("with the owner's task manager off the night keeps its three stages", async () => {
  const off: (NightlyOptions | undefined)[] = [
    undefined,
    { tasks: false },
    { scope: "nightly", tasks: false },
  ];
  for (const options of off) {
    const { run, events, ordered } = recorder({}, "embeddings");
    const { failed, jobs } = await runNightlyStages(run, options);
    assert.equal(failed, false);
    assert.deepEqual(Object.keys(jobs).sort(), [
      "consolidation",
      "embeddings",
      "export",
    ]);
    assert.equal(events.length, 6);
    ordered("end:consolidation", "start:embeddings", "end:embeddings");
    ordered("end:consolidation", "start:export", "end:export");
  }
});

test("failed or throwing task phases never fail the night, and the chain continues", async () => {
  for (const outcome of ["failed", "throw"]) {
    const { run, events } = recorder({
      task_keeper: outcome,
      consolidation: "throw",
    });
    const { failed, jobs } = await runNightlyStages(run, { tasks: true });
    assert.equal(failed, true, "consolidation bookkeeping still fails");
    assert.equal(jobs.consolidation?.status, "failed");
    assert.equal(
      jobs.consolidation?.error,
      "Consolidation bookkeeping failed.",
    );
    assert.equal(jobs.task_keeper?.status, "failed");
    assert.ok(events.includes("end:task_links"));
    const healthy = recorder({ task_keeper: outcome, task_links: "failed" });
    const night = await runNightlyStages(healthy.run, { tasks: true });
    assert.equal(night.failed, false);
    assert.equal(night.jobs.task_links?.status, "failed");
    if (outcome === "throw")
      assert.equal(
        night.jobs.task_keeper?.error,
        "Maintenance bookkeeping failed.",
      );
  }
  const partial = recorder({ task_keeper: "partial", task_links: "partial" });
  assert.equal(
    (await runNightlyStages(partial.run, { tasks: true })).failed,
    false,
  );
  for (const stage of ["embeddings", "export"] as const) {
    const broken = recorder({ [stage]: "failed" });
    const night = await runNightlyStages(broken.run, { tasks: true });
    assert.equal(night.failed, true);
    assert.ok(broken.events.includes("end:task_links"));
  }
});

test("Run now executes only the two task phases, in order", async () => {
  const events: string[] = [];
  const { failed, jobs } = await runNightlyStages(
    async (kind) => {
      events.push(kind);
      return { status: kind === "task_keeper" ? "failed" : "partial" };
    },
    { scope: "tasks" },
  );
  assert.equal(failed, false);
  assert.deepEqual(events, ["task_keeper", "task_links"]);
  assert.deepEqual(Object.keys(jobs), ["task_keeper", "task_links"]);
});
