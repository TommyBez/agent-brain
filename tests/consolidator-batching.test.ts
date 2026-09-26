import assert from "node:assert/strict";
import test from "node:test";
import { batchQuestions } from "../lib/maintenance/consolidator/batching";
import { POLICY, type Question } from "../lib/maintenance/consolidator/types";

const question: Question = {
  type: "boolean",
  instructions: 'Check "a\\b" 🧠.',
};

test("batch sizing includes JSON escaping and accepts the exact input boundary", () => {
  const questions = { 'quoted"id': question };
  const overhead = JSON.stringify({ state: "", questions }).length;
  const state = "x".repeat(POLICY.evaluationCharacters - overhead);
  const exact = batchQuestions(state, questions);
  assert.deepEqual(exact, { batches: [questions], oversized: [] });
  assert.equal(
    JSON.stringify({ state, questions: exact.batches[0] }).length,
    POLICY.evaluationCharacters,
  );
  assert.deepEqual(batchQuestions(`${state}x`, questions), {
    batches: [],
    oversized: ['quoted"id'],
  });
});

test("batching keeps every question once while respecting both provider limits", () => {
  const state = { text: "x".repeat(POLICY.evaluationCharacters - 1000) };
  const questions = Object.fromEntries(
    Array.from({ length: 200 }, (_, index) => [`q${index}`, question]),
  );
  const { batches, oversized } = batchQuestions(state, questions);
  assert.deepEqual(oversized, []);
  assert.deepEqual(batches.flatMap(Object.keys), Object.keys(questions));
  assert.ok(batches.length > Math.ceil(200 / POLICY.questionsPerRequest));
  for (const batch of batches) {
    assert.ok(Object.keys(batch).length <= POLICY.questionsPerRequest);
    assert.ok(
      JSON.stringify({ state, questions: batch }).length <=
        POLICY.evaluationCharacters,
    );
  }
  const countBounded = batchQuestions({}, questions);
  assert.equal(
    Object.keys(countBounded.batches[0]).length,
    POLICY.questionsPerRequest,
  );
});
