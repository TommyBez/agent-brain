import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTask } from "../lib/maintenance/consolidator/analysis";
import { canReuseAnalysis } from "../lib/maintenance/consolidator/reuse";
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

test("independent partner selections share page state and batch without losing anchors", async () => {
  const snapshot = buildSnapshot([
    page(
      "a",
      Array.from({ length: 60 }, (_, i) => `Passage ${i}.`).join("\n\n"),
    ),
  ]);
  const calls: EvaluationRequest[] = [];
  await analyzeTask(
    snapshot,
    createAnalysisTasks(snapshot)[0],
    evaluator((id) => {
      if (id === "duplicate" || id.startsWith("passage_")) return 1;
      if (id.startsWith("partner_")) return "none";
      return 0;
    }, calls),
  );
  const partners = calls.filter((call) =>
    Object.keys(call.questions).some((id) => id.startsWith("partner_")),
  );
  assert.ok(partners.length < 60);
  assert.equal(
    partners.flatMap((call) => Object.keys(call.questions)).length,
    60,
  );
  const instructions = partners.flatMap((call) =>
    Object.values(call.questions).map((question) => question.instructions),
  );
  for (const unit of snapshot.units)
    assert.equal(
      instructions.filter((text) =>
        text.includes(`anchor passage ${unit.id} in units`),
      ).length,
      1,
    );
  for (const call of partners) {
    assert.ok(Object.keys(call.questions).length <= 48);
    assert.ok(JSON.stringify(call).length <= 100_000);
    assert.equal(JSON.stringify(call.state).split("Passage 59.").length - 1, 1);
  }
});

test("two candidates combine counterpart confirmation and preparation in one request", async () => {
  const { snapshot, task } = pair();
  const calls: EvaluationRequest[] = [];
  const result = await analyzeTask(
    snapshot,
    task,
    evaluator(
      (id) =>
        id.startsWith("passage_")
          ? 0.7
          : ["duplicate", "counterpart", "actionable"].includes(id)
            ? 1
            : id.startsWith("partner_")
              ? "p0"
              : id === "destination"
                ? "a"
                : 0,
      calls,
    ),
  );
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => !call.questions.partner_0));
  assert.deepEqual(Object.keys(calls[2].questions), [
    "counterpart",
    "destination",
    "actionable",
  ]);
  assert.match(
    calls[2].questions.counterpart.instructions,
    /target\[0\].*target\[1\]/,
  );
  assert.match(calls[2].questions.actionable.instructions, /^Assuming /);
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
      id === "duplicate" || id === "counterpart" || id.startsWith("passage_")
        ? 1
        : id.startsWith("partner_")
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
    "Atlas uses PostgreSQL. See /pages/decision/source/#details.",
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
      if (["conflict", "counterpart"].includes(id) || id.startsWith("passage_"))
        return 1;
      if (id.startsWith("partner_")) return "p0";
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
    "Current state A. See /pages/source/.",
    "Current state B.",
  );
  const result = await analyzeTask(
    snapshot,
    task,
    evaluator((id) =>
      id === "conflict" || id === "counterpart" || id.startsWith("passage_")
        ? 1
        : id.startsWith("partner_")
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

test("long positive pages fit localization and direct-pair preparation without truncation", async () => {
  const markdown = Array.from(
    { length: 32 },
    (_, i) => `Passage ${i}: ${"x".repeat(1800)} unique-marker-${i}.`,
  ).join("\n\n");
  const snapshot = buildSnapshot([page("long", markdown)]);
  const calls: EvaluationRequest[] = [];
  const result = await analyzeTask(
    snapshot,
    createAnalysisTasks(snapshot)[0],
    evaluator((id) => {
      if (
        [
          "duplicate",
          "counterpart",
          "actionable",
          "passage_0",
          "passage_1",
        ].includes(id)
      )
        return 1;
      if (id.startsWith("partner_")) return "p0";
      if (id === "destination") return "equivalent";
      return 0;
    }, calls),
  );
  assert.equal(result.status, "complete");
  assert.equal(result.findings[0].status, "supported");
  const localized = calls.filter(
    (call) => call.questions.passage_0 || call.questions.partner_0,
  );
  assert.ok(localized.length >= 1);
  assert.ok(calls.some((call) => call.questions.counterpart));
  assert.ok(calls.every((call) => !call.questions.partner_0));
  for (const request of localized) {
    const serialized = JSON.stringify(request.state);
    assert.equal(serialized.split("unique-marker-0.").length - 1, 1);
    assert.equal(serialized.split("unique-marker-31.").length - 1, 1);
    assert.ok(JSON.stringify(request).length < 100_000);
  }
});

test("screening below 80% ends the task without localization or preparation", async () => {
  const { snapshot, task } = pair();
  for (const probability of [0.5, 0.79, 0.799]) {
    const calls: EvaluationRequest[] = [];
    const result = await analyzeTask(
      snapshot,
      task,
      evaluator(() => probability, calls),
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(result.findings, []);
  }
});

test("localization below 70% cannot generate partner or preparation requests", async () => {
  const { snapshot, task } = pair();
  const calls: EvaluationRequest[] = [];
  const result = await analyzeTask(
    snapshot,
    task,
    evaluator((id) => {
      if (id === "duplicate") return 0.8;
      if (id.startsWith("passage_")) return 0.699;
      return 0;
    }, calls),
  );
  assert.equal(calls.length, 2);
  assert.equal(result.findings[0].status, "uncertain");
  assert.deepEqual(result.findings[0].unitIds, []);
});

test("partner probability, rather than distribution confidence, gates preparation at 80%", async () => {
  const { snapshot, task } = pair(
    "Giulia leads Atlas.\n\nGiulia approves its budget.",
    "Giulia leads Atlas and approves its budget.",
  );
  for (const probability of [0.79, 0.8]) {
    const calls: EvaluationRequest[] = [];
    const answer = evaluator((id) => {
      if (
        id === "duplicate" ||
        id === "actionable" ||
        id.startsWith("passage_")
      )
        return 0.8;
      if (id.startsWith("partner_")) return "p0";
      if (id === "destination") return "a";
      return 0;
    }, calls);
    const result = await analyzeTask(snapshot, task, async (request) => {
      const response = await answer(request);
      for (const [id, value] of Object.entries(response.answers)) {
        if (id.startsWith("partner_") && value.type === "choice") {
          value.probabilities = Object.fromEntries(
            Object.keys(value.probabilities).map((key) => [
              key,
              key === "p0" ? probability : key === "none" ? 1 - probability : 0,
            ]),
          );
          value.confidence = probability < 0.8 ? 1 : 0;
        }
        if (id === "destination" && value.type === "choice") {
          value.probabilities = { a: 0.4, b: 0.3, equivalent: 0.2, none: 0.1 };
          value.confidence = 0;
        }
      }
      return response;
    });
    assert.equal(
      calls.some((call) => call.questions.actionable !== undefined),
      probability >= 0.8,
    );
    assert.equal(result.findings.length, probability >= 0.8 ? 2 : 0);
    if (probability >= 0.8)
      assert.equal(result.findings[0].status, "supported");
  }
});

test("direct pairs require 80% confirmation even when speculative intervention answers pass", async () => {
  for (const kind of ["duplicate", "conflict"] as const) {
    const { snapshot, task } = pair();
    for (const probability of [0, 0.79, 0.8]) {
      const calls: EvaluationRequest[] = [];
      const result = await analyzeTask(
        snapshot,
        task,
        evaluator((id) => {
          if (id === kind || id === "actionable") return 1;
          if (id.startsWith("passage_")) return 0.7;
          if (id === "counterpart") return probability;
          if (id === "destination" || id === "resolution") return "a";
          return 0;
        }, calls),
      );
      assert.equal(calls.length, 3);
      assert.ok(calls.every((call) => !call.questions.partner_0));
      assert.ok(calls[2].questions.counterpart);
      assert.ok(
        calls[2].questions[kind === "duplicate" ? "actionable" : "resolution"],
      );
      assert.equal(result.findings.length, probability >= 0.8 ? 1 : 0);
      if (probability >= 0.8)
        assert.equal(result.findings[0].status, "supported");
    }
  }
});

test("two passages in one document use the direct-pair path", async () => {
  const snapshot = buildSnapshot([
    page("a", "Giulia leads Atlas.\n\nAtlas is led by Giulia."),
  ]);
  const calls: EvaluationRequest[] = [];
  const result = await analyzeTask(
    snapshot,
    createAnalysisTasks(snapshot)[0],
    evaluator((id) => {
      if (["duplicate", "counterpart", "actionable"].includes(id)) return 1;
      if (id.startsWith("passage_")) return 0.7;
      if (id === "destination") return "a";
      return 0;
    }, calls),
  );
  assert.equal(calls.length, 3);
  assert.equal(result.findings[0].kind, "deduplicate");
  assert.equal(result.findings[0].status, "supported");
});

test("page-pair candidates in the same page cannot be treated as a cross-page counterpart", async () => {
  const { snapshot, task } = pair(
    "Giulia leads Atlas.\n\nAtlas is led by Giulia.",
    "Unrelated information.",
  );
  const calls: EvaluationRequest[] = [];
  const result = await analyzeTask(
    snapshot,
    task,
    evaluator((id) => {
      if (["duplicate", "counterpart", "actionable"].includes(id)) return 1;
      if (id === "passage_0" || id === "passage_1") return 0.7;
      return 0;
    }, calls),
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(result.findings, []);
});

test("an unconfirmed direct conflict pair does not fetch speculative resolution sources", async () => {
  const { snapshot: initial, task } = pair(
    "Current state A. See /pages/source/.",
    "Current state B.",
  );
  const snapshot = buildSnapshot([
    ...initial.pages,
    page("source", "Decision."),
  ]);
  const calls: EvaluationRequest[] = [];
  const result = await analyzeTask(
    snapshot,
    task,
    evaluator((id) => {
      if (id === "conflict" || id.startsWith("passage_")) return 1;
      if (id === "counterpart") return 0.79;
      if (id === "resolution") return "insufficient";
      return 0;
    }, calls),
  );
  assert.equal(calls.length, 3);
  assert.equal(
    result.dependencies?.some((ref) => ref.pageId === "source"),
    false,
  );
  assert.deepEqual(result.findings, []);
});
