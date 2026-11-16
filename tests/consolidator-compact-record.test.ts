import assert from "node:assert/strict";
import test from "node:test";
import { compactRecord } from "../lib/maintenance/consolidator/compact-record";
import { evaluationCacheKey } from "../lib/maintenance/consolidator/evaluation-cache";
import { JEV_MODEL } from "../lib/maintenance/consolidator/jev";

test("compact judgments retain debug answers and exact evaluation identity without source text", () => {
  const request = {
    state: { text: "Synthetic source text" },
    questions: {
      choice: {
        type: "choice" as const,
        instructions: "Pick",
        criteria: { a: "First", b: "Second" },
      },
    },
  };
  const response = {
    model: JEV_MODEL,
    promptVersion: "test-prompt",
    inputTokens: 20,
    outputTokens: 2,
    answers: {
      choice: {
        type: "choice" as const,
        choice: "a",
        probabilities: { a: 0.9, b: 0.1 },
        confidence: 0.9,
      },
    },
  };
  const input = {
    status: "complete",
    judgments: [
      { ...request, ...response, providerMetadata: { text: "Do not retain" } },
    ],
  };
  const expected = {
    status: "complete",
    judgments: [{ evaluationKey: evaluationCacheKey(request), ...response }],
  };
  assert.deepEqual(compactRecord(input), expected);
  assert.deepEqual(compactRecord({ verification: input }), {
    verification: expected,
  });
  assert.deepEqual(compactRecord(expected), expected);
  assert.equal(input.judgments[0].state.text, "Synthetic source text");
});
