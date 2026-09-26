import assert from "node:assert/strict";
import test from "node:test";
import type { BrainPage } from "../lib/brain/types";
import { analyzeTask } from "../lib/maintenance/consolidator/analysis";
import {
  buildSnapshot,
  createAnalysisTasks,
} from "../lib/maintenance/consolidator/snapshot";
import {
  type Answer,
  type Evaluation,
  type EvaluationRequest,
  POLICY,
} from "../lib/maintenance/consolidator/types";

function page(id: string, items: number): BrainPage {
  return {
    id,
    slug: id,
    title: id,
    type: "note",
    summary: "",
    aliases: [],
    tags: [],
    version: 1,
    createdAt: "2026-09-26",
    updatedAt: "2026-09-26",
    embeddedAt: null,
    markdown: "- x\n".repeat(items),
    links: [],
    backlinks: [],
  };
}

function noCandidates(request: EvaluationRequest): Evaluation {
  const answers: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === "boolean")
      answers[id] = { type: "boolean", probability: 0 };
    else {
      const choice = id.endsWith("relationship") ? "compatible" : "none";
      answers[id] = {
        type: "choice",
        choice,
        confidence: 1,
        probabilities: Object.fromEntries(
          Object.keys(question.criteria).map((key) => [
            key,
            key === choice ? 1 : 0,
          ]),
        ),
      };
    }
  }
  return { answers, model: "test", inputTokens: null, outputTokens: null };
}

test("thousands of short list items cannot create an unbounded diagnosis task", async () => {
  const snapshot = buildSnapshot([page("dense", 2500)]);
  assert.ok(snapshot.pages[0].markdown.length < POLICY.windowCharacters);
  const tasks = createAnalysisTasks(snapshot);
  assert.ok(
    tasks.every((task) => task.unitIds.length <= 2 * POLICY.windowUnits),
  );
  const first = snapshot.units[0].id;
  const last = snapshot.units.at(-1)?.id as string;
  const distant = tasks.find(
    (task) => task.unitIds.includes(first) && task.unitIds.includes(last),
  );
  assert.ok(
    distant,
    "distant pairs remain covered after splitting the dense page",
  );
  let questions = 0;
  let requests = 0;
  const result = await analyzeTask(snapshot, distant, async (request) => {
    requests++;
    questions += Object.keys(request.questions).length;
    assert.ok(
      Object.keys(request.questions).length <= POLICY.questionsPerRequest,
    );
    assert.ok(JSON.stringify(request).length <= POLICY.evaluationCharacters);
    return noCandidates(request);
  });
  assert.equal(result.status, "complete");
  assert.ok(requests > 1);
  assert.ok(
    questions < 8000,
    "question count is bounded by units per task, not page density",
  );
});

test("multi-window diagnosis asks each residue and unit-pair criterion exactly once", async () => {
  const snapshot = buildSnapshot([
    page("a", 2 * POLICY.windowUnits + 3),
    page("b", POLICY.windowUnits + 3),
  ]);
  const tasks = createAnalysisTasks(snapshot);
  const residueChecks = new Map<string, Map<string, number>>();
  const pairChecks = new Map<string, Map<string, number>>();
  const count = (
    checks: Map<string, Map<string, number>>,
    target: string,
    criterion: string,
  ) => {
    const counts = checks.get(target) ?? new Map<string, number>();
    counts.set(criterion, (counts.get(criterion) ?? 0) + 1);
    checks.set(target, counts);
  };
  let requests = 0;
  for (const task of tasks) {
    const result = await analyzeTask(snapshot, task, async (request) => {
      requests++;
      const { units } = request.state as { units: { id: string }[] };
      for (const id of Object.keys(request.questions)) {
        const residue = /^unit_(\d+)\.(.+)$/.exec(id);
        if (residue) {
          assert.equal(task.crossWindow, undefined);
          count(residueChecks, units[Number(residue[1])].id, residue[2]);
        }
        const pair = /^pair_(\d+)_(\d+)\.(.+)$/.exec(id);
        if (pair)
          count(
            pairChecks,
            [units[Number(pair[1])].id, units[Number(pair[2])].id]
              .sort()
              .join("|"),
            pair[3],
          );
      }
      return noCandidates(request);
    });
    assert.equal(result.status, "complete");
  }
  assert.ok(requests > tasks.length, "counts actual batched model requests");
  for (const unit of snapshot.units) {
    assert.deepEqual(
      residueChecks.get(unit.id),
      new Map([
        ["residue", 1],
        ["distinct", 1],
      ]),
      `residue checks for ${unit.id}`,
    );
  }
  const expectedCriteria = [
    "entity",
    "overlap",
    "a_in_b",
    "b_in_a",
    "a_distinct",
    "b_distinct",
    "a_context",
    "b_context",
    "destination",
    "relationship",
    "resolution",
    "correction",
    "transition",
    "scope",
  ].sort();
  for (let i = 0; i < snapshot.units.length; i++) {
    for (let j = i + 1; j < snapshot.units.length; j++) {
      const pair = [snapshot.units[i].id, snapshot.units[j].id]
        .sort()
        .join("|");
      const counts = pairChecks.get(pair);
      assert.ok(counts, `missing diagnosis for ${pair}`);
      assert.deepEqual([...counts.keys()].sort(), expectedCriteria);
      assert.ok(
        [...counts.values()].every((value) => value === 1),
        `repeated diagnosis for ${pair}`,
      );
    }
  }
});

test("unit-count windows preserve coverage of every within-page and cross-page pair", () => {
  const snapshot = buildSnapshot([page("a", 67), page("b", 35)]);
  const tasks = createAnalysisTasks(snapshot);
  const covered = new Set<string>();
  for (const task of tasks) {
    for (let i = 0; i < task.unitIds.length; i++) {
      for (let j = i + 1; j < task.unitIds.length; j++) {
        covered.add([task.unitIds[i], task.unitIds[j]].sort().join("|"));
      }
    }
  }
  for (let i = 0; i < snapshot.units.length; i++) {
    for (let j = i + 1; j < snapshot.units.length; j++) {
      assert.ok(
        covered.has(
          [snapshot.units[i].id, snapshot.units[j].id].sort().join("|"),
        ),
      );
    }
  }
});
