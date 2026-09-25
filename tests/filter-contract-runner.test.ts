import assert from "node:assert/strict";
import test from "node:test";
import { CONSOLIDATION_CRITERIA } from "../lib/maintenance/consolidation-rubric";
import { KIMI_MODEL } from "../lib/maintenance/kimi-evaluator";
import { evaluateFixedCase } from "../scripts/evaluate-filter-contract";

test("fixed filter delegates only gray criteria and keeps reference metadata out of both models", async () => {
  const input = {
    before: "A. A.",
    after: "A.",
    evidence: "A.",
    operation: "deduplicate",
  };
  const result = await evaluateFixedCase(
    { ...input, ...{ expectedDecision: "FORBIDDEN", rationale: "FORBIDDEN" } },
    {
      supported_by_evidence: { allowBelow: 0.12, rejectAtOrAbove: 0.94 },
      preserves_distinct_information: {
        allowBelow: 0.23,
        rejectAtOrAbove: 0.79,
      },
      no_new_human_action: { allowBelow: 0.49, rejectAtOrAbove: 0.9 },
      meaningful_improvement: { allowBelow: 0.09, rejectAtOrAbove: 0.72 },
    },
    {
      jev: async (clean) => {
        assert.deepEqual(clean, input);
        return {
          status: "success",
          result: {
            model: "typesafe-ai/jev",
            usage: {},
            answers: {
              supported_by_evidence: 0.4,
              preserves_distinct_information: 0.02,
              no_new_human_action: 0.01,
              meaningful_improvement: 0.03,
            },
            // Deliberately misleading legacy positive-polarity field must be ignored.
            allowed: false,
          },
        };
      },
      kimi: async (clean, selected) => {
        assert.deepEqual(clean, input);
        assert.deepEqual(selected, ["supported_by_evidence"]);
        return {
          status: "success",
          result: {
            model: KIMI_MODEL,
            responseModel: KIMI_MODEL,
            responseId: null,
            latencyMs: 1,
            judgments: {
              supported_by_evidence: {
                verdict: "pass",
                rationale: "Il fatto A resta invariato.",
              },
            },
            usage: {
              inputTokens: null,
              outputTokens: null,
              totalTokens: null,
              reasoningTokens: null,
              cachedInputTokens: null,
              costUsd: null,
            },
          },
        };
      },
    },
  );
  assert.equal(result.route, "defer");
  assert.equal(result.finalDecision, "accept");
  for (const key of CONSOLIDATION_CRITERIA)
    assert.equal(result.finalCriteria[key], "pass");
});
