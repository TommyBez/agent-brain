import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { runNightlyStages } from "../lib/maintenance/nightly-stages";

test("nightly runs only consolidation, embeddings, hygiene and export", async () => {
  const calls: string[] = [];
  const result = await runNightlyStages(
    async (kind) => {
      calls.push(kind);
      return { status: "succeeded" };
    },
    { tasks: true },
  );
  assert.deepEqual(calls, [
    "consolidation",
    "embeddings",
    "export",
    "task_keeper",
  ]);
  assert.equal(result.failed, false);
});

test("nightly without tasks preserves page stages", async () => {
  const calls: string[] = [];
  await runNightlyStages(async (kind) => {
    calls.push(kind);
    return { status: "succeeded" };
  });
  assert.deepEqual(calls, ["consolidation", "embeddings", "export"]);
});

test("stage failure does not prevent the remaining stages", async () => {
  const calls: string[] = [];
  const result = await runNightlyStages(
    async (kind) => {
      calls.push(kind);
      if (kind === "consolidation") throw new Error("failed");
      return { status: "succeeded" };
    },
    { tasks: true },
  );
  assert.equal(result.failed, true);
  assert.equal(calls.length, 4);
});

test("nightly cannot extract tasks, instantiate occurrences or write task links", () => {
  for (const path of [
    "lib/maintenance/task-keeper/recurrences.ts",
    "lib/maintenance/task-keeper/apply.ts",
    "lib/maintenance/task-links",
    "lib/tasks/derived-links.ts",
  ])
    assert.equal(existsSync(path), false, path);
  for (const path of [
    "lib/maintenance/task-keeper/index.ts",
    "lib/maintenance/task-keeper/steps.ts",
    "lib/maintenance/task-keeper/hygiene.ts",
  ])
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /createTask\(|INSERT INTO brain_tasks\b|INSERT INTO brain_task_links\b|instantiateRecurrences/,
    );
});

test("Operations offers no manual task phase start", () => {
  for (const path of [
    "components/settings/operations-controls.tsx",
    "lib/maintenance/start.ts",
    "lib/maintenance/jobs.ts",
  ])
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /startTaskMaintenance|requeueTaskWorkflowJobs|TaskMaintenanceControl|scope: "tasks"/,
    );
});
