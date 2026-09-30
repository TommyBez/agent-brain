import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTask } from "../lib/maintenance/consolidator/analysis";
import {
  buildSnapshot,
  createAnalysisTasks,
} from "../lib/maintenance/consolidator/snapshot";
import type { EvaluationRequest } from "../lib/maintenance/consolidator/types";
import { evaluator, page } from "./helpers/consolidator";

test("30 pages require 30 document and 435 pair screens regardless of paragraph count", async () => {
  const snapshot = buildSnapshot(
    Array.from({ length: 30 }, (_, i) =>
      page(String(i), "- A fact.\n".repeat(25)),
    ),
  );
  const tasks = createAnalysisTasks(snapshot);
  assert.equal(tasks.filter((task) => task.kind === "document").length, 30);
  assert.equal(tasks.filter((task) => task.kind === "pair").length, 435);
  const calls: EvaluationRequest[] = [];
  for (const task of tasks)
    await analyzeTask(
      snapshot,
      task,
      evaluator(() => 0, calls),
    );
  assert.equal(calls.length, 465);
  assert.equal(
    calls.reduce((n, call) => n + Object.keys(call.questions).length, 0),
    1830,
  );
});

test("a dense page with 2500 list items still receives one three-question screen", async () => {
  const snapshot = buildSnapshot([page("dense", "- x\n".repeat(2500))]);
  const calls: EvaluationRequest[] = [];
  const tasks = createAnalysisTasks(snapshot);
  assert.equal(tasks.length, 1);
  const result = await analyzeTask(
    snapshot,
    tasks[0],
    evaluator(() => 0, calls),
  );
  assert.equal(result.status, "complete");
  assert.equal(calls.length, 1);
  assert.equal(Object.keys(calls[0].questions).length, 3);
});

test("one changed page invalidates its document and N-1 pairs; metadata changes invalidate none", () => {
  const pages = Array.from({ length: 100 }, (_, i) => page(String(i)));
  const initial = new Set(
    createAnalysisTasks(buildSnapshot(pages)).map((task) => task.id),
  );
  const technical = pages.map((page) => ({
    ...page,
    version: page.version + 1,
    updatedAt: "2026-10-01",
    embeddedAt: "2026-10-01",
  }));
  assert.ok(
    createAnalysisTasks(buildSnapshot(technical)).every((task) =>
      initial.has(task.id),
    ),
  );
  technical[0].markdown += " A new fact.";
  assert.equal(
    createAnalysisTasks(buildSnapshot(technical)).filter(
      (task) => !initial.has(task.id),
    ).length,
    100,
  );
});
