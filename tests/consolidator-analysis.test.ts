import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTask } from "../lib/maintenance/consolidator/analysis";
import { canReuseAnalysis } from "../lib/maintenance/consolidator/cache";
import {
  buildSnapshot,
  createAnalysisTasks,
} from "../lib/maintenance/consolidator/snapshot";
import type { EvaluationRequest } from "../lib/maintenance/consolidator/types";
import { evaluator, page } from "./helpers/consolidator";

function pair(
  textA = "Giulia leads Atlas.",
  textB = "Giulia leads Atlas and approves its budget.",
) {
  const snapshot = buildSnapshot([page("a", textA), page("b", textB)]);
  const task = createAnalysisTasks(snapshot).find(
    (task) => task.kind === "pair",
  );
  assert.ok(task);
  return { snapshot, task };
}

test("negative screening sends full pages in one request with exactly four independent judgments", async () => {
  const { snapshot, task } = pair();
  const calls: EvaluationRequest[] = [];
  const result = await analyzeTask(
    snapshot,
    task,
    evaluator(() => 0, calls),
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].questions), [
    "duplicate",
    "conflict",
    "link_ab",
    "link_ba",
  ]);
  assert.ok(
    JSON.stringify(calls[0].state).includes(snapshot.pages[1].markdown),
  );
  assert.equal(JSON.stringify(calls[0].state).includes("updatedAt"), false);
  assert.equal(result.status, "complete");
  assert.deepEqual(result.findings, []);
});

test("a positive duplicate is localized then given a destination and preservation constraint", async () => {
  const { snapshot, task } = pair();
  const calls: EvaluationRequest[] = [];
  const result = await analyzeTask(
    snapshot,
    task,
    evaluator(
      (id) =>
        id.startsWith("passage_")
          ? 0.71
          : id === "duplicate" || id === "actionable"
            ? 1
            : id === "partner"
              ? "p0"
              : id === "destination"
                ? "a"
                : 0,
      calls,
    ),
  );
  assert.ok(calls.some((call) => call.questions.partner));
  assert.ok(calls.some((call) => call.questions.destination));
  assert.equal(calls.filter((call) => call.questions.duplicate).length, 1);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].status, "supported");
  assert.equal(result.findings[0].kind, "centralize");
  assert.ok(result.findings[0].retainedUnitId);
  assert.match(result.findings[0].goal, /every distinct detail/);
});

test("an unsupported preparation cannot authorize deleting the localized passage", async () => {
  const { snapshot, task } = pair();
  const result = await analyzeTask(
    snapshot,
    task,
    evaluator((id) =>
      id === "duplicate" || id.startsWith("passage_")
        ? 1
        : id === "partner"
          ? "p0"
          : id === "destination"
            ? "a"
            : 0,
    ),
  );
  assert.ok(result.findings.length);
  assert.ok(result.findings.every((finding) => finding.status === "uncertain"));
});

test("contradictions consult only explicit sources and cache their semantic dependencies", async () => {
  const { snapshot: initial, task } = pair(
    "Atlas uses PostgreSQL. See /pages/decision/source.",
    "Atlas uses MySQL.",
  );
  const source = page(
    "source",
    "Decision: Atlas completed its migration to PostgreSQL.",
  );
  source.slug = "decision/source";
  const unrelated = page("unrelated", "Never send this page to Jev.");
  const snapshot = buildSnapshot([...initial.pages, source, unrelated]);
  const calls: EvaluationRequest[] = [];
  const result = await analyzeTask(
    snapshot,
    task,
    evaluator((id, request) => {
      if (id === "conflict" || id.startsWith("passage_")) return 1;
      if (id === "partner") return "p0";
      if (id === "resolution")
        return JSON.stringify(request.state).includes("completed its migration")
          ? "a"
          : "insufficient";
      return 0;
    }, calls),
  );
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.kind === "reconcile" && finding.status === "supported",
    ),
  );
  assert.ok(
    calls.some((call) => JSON.stringify(call.state).includes(source.markdown)),
  );
  assert.ok(
    calls.every(
      (call) => !JSON.stringify(call.state).includes(unrelated.markdown),
    ),
  );
  assert.equal(
    canReuseAnalysis(
      buildSnapshot([
        ...initial.pages,
        source,
        { ...unrelated, markdown: "Changed." },
      ]),
      result,
    ),
    true,
  );
  assert.equal(
    canReuseAnalysis(
      buildSnapshot([
        ...initial.pages,
        { ...source, markdown: "Decision reversed." },
        unrelated,
      ]),
      result,
    ),
    false,
  );
});

test("a specifically missing source invalidates the unresolved result when it becomes available", async () => {
  const { snapshot, task } = pair(
    "Current state A. See /pages/source.",
    "Current state B.",
  );
  const result = await analyzeTask(
    snapshot,
    task,
    evaluator((id) =>
      id === "conflict" || id.startsWith("passage_")
        ? 1
        : id === "partner"
          ? "p0"
          : id === "resolution"
            ? "insufficient"
            : 0,
    ),
  );
  assert.equal(canReuseAnalysis(snapshot, result), true);
  assert.equal(
    canReuseAnalysis(
      buildSnapshot([...snapshot.pages, page("source")]),
      result,
    ),
    false,
  );
  assert.ok(result.findings.every((finding) => finding.status === "uncertain"));
});

test("link planning selects a typed directed relation without a text editor or fragment comparisons", async () => {
  const { snapshot, task } = pair(
    "Giulia works at Atlas.",
    "Atlas is a company.",
  );
  const calls: EvaluationRequest[] = [];
  const result = await analyzeTask(
    snapshot,
    task,
    evaluator(
      (id) => (id === "link_ab" ? 1 : id === "relation" ? "works_at" : 0),
      calls,
    ),
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(result.findings[0].link, {
    sourceId: "a",
    targetId: "b",
    type: "works_at",
  });
});

test("provider failure propagates instead of becoming a cached negative", async () => {
  const { snapshot, task } = pair();
  await assert.rejects(
    analyzeTask(snapshot, task, async () => {
      throw new Error("Provider unavailable");
    }),
    /Provider unavailable/,
  );
});

test("oversized full pages remain incomplete instead of being silently truncated", async () => {
  const snapshot = buildSnapshot([page("large", "x".repeat(101_000))]);
  let calls = 0;
  const result = await analyzeTask(
    snapshot,
    createAnalysisTasks(snapshot)[0],
    async () => {
      calls++;
      throw new Error("Must not call");
    },
  );
  assert.equal(calls, 0);
  assert.equal(result.status, "incomplete");
});
