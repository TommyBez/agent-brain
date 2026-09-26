import assert from "node:assert/strict";
import test from "node:test";
import type { BrainPage } from "../lib/brain/types";
import { analyzeTask } from "../lib/maintenance/consolidator/analysis";
import {
  buildSnapshot,
  createAnalysisTasks,
} from "../lib/maintenance/consolidator/snapshot";
import { type Answer, POLICY } from "../lib/maintenance/consolidator/types";

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
  });
  assert.equal(result.status, "complete");
  assert.ok(requests > 1);
  assert.ok(
    questions < 8000,
    "question count is bounded by units per task, not page density",
  );
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
