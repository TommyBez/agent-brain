import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateOutcome } from "../lib/maintenance/consolidation-candidate";
import {
  KIMI_MODEL,
  type KimiEvaluation,
  type KimiReviewReceipt,
  type KimiUsage,
} from "../lib/maintenance/kimi-evaluator";
import { auditKimiAccounting } from "../scripts/audit-consolidation-candidate";

const unknownUsage: KimiUsage = {
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  reasoningTokens: null,
  cachedInputTokens: null,
  costUsd: null,
};
const knownUsage: KimiUsage = {
  inputTokens: 20,
  outputTokens: 5,
  totalTokens: 25,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  costUsd: 0.012345678901,
};
function review(
  name: KimiReviewReceipt["review"],
  usage: KimiUsage,
  outcome: KimiReviewReceipt["outcome"] = "success",
): KimiReviewReceipt {
  return {
    review: name,
    outcome,
    usage,
    responseId: null,
    responseModel: KIMI_MODEL,
    latencyMs: 1,
  };
}
function success(
  usage: KimiUsage,
  reviewReceipts?: KimiReviewReceipt[],
): CandidateOutcome<KimiEvaluation> {
  return {
    status: "success",
    result: {
      model: KIMI_MODEL,
      responseId: null,
      responseModel: KIMI_MODEL,
      latencyMs: 2,
      judgments: {},
      usage,
      ...(reviewReceipts === undefined ? {} : { reviewReceipts }),
    },
  };
}

test("Kimi accounting counts physical reviews and retains partial unknown costs", () => {
  const result = auditKimiAccounting(
    success(
      {
        ...knownUsage,
        physicalCalls: 2,
        unknownCostCalls: 1,
        unknownTokenCalls: 1,
      },
      [review("primary", knownUsage), review("counterexample", unknownUsage)],
    ),
  );
  assert.deepEqual(result, {
    physicalCalls: 2,
    inputTokens: 20,
    outputTokens: 5,
    costPico: 12_345_678_901,
    unknownCostCalls: 1,
    unknownTokenCalls: 1,
  });
});

test("Kimi accounting preserves both unknown calls in a failed composite evaluation", () => {
  const result = auditKimiAccounting({
    status: "error",
    error: {
      kind: "invalid_response",
      status: null,
      retryable: false,
      retryAfterMs: null,
      diagnostic: {
        stage: "source_challenge",
        reasonCode: "challenge_unavailable",
        responseId: null,
        responseModel: null,
        latencyMs: 2,
        usage: {
          ...unknownUsage,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          physicalCalls: 2,
          unknownCostCalls: 2,
          unknownTokenCalls: 2,
        },
        reviewReceipts: [
          review("primary", unknownUsage),
          review("counterexample", unknownUsage, "error"),
        ],
      },
    },
  });
  assert.equal(result.physicalCalls, 2);
  assert.equal(result.costPico, 0);
  assert.equal(result.unknownCostCalls, 2);
  assert.equal(result.unknownTokenCalls, 2);
  assert.equal(auditKimiAccounting(success(unknownUsage)).unknownCostCalls, 1);
});

test("Kimi audit rejects totals that hide costs, unknown usage or physical attempts", () => {
  const aggregate: KimiUsage = {
    ...knownUsage,
    physicalCalls: 2,
    unknownCostCalls: 1,
    unknownTokenCalls: 1,
  };
  const receipts = [
    review("primary", knownUsage),
    review("counterexample", unknownUsage, "error"),
  ];
  for (const change of [
    { physicalCalls: 1 },
    { unknownCostCalls: 0 },
    { unknownTokenCalls: 0 },
    { inputTokens: 19 },
    { outputTokens: 4 },
    { costUsd: 0 },
  ])
    assert.throws(() =>
      auditKimiAccounting(success({ ...aggregate, ...change }, receipts)),
    );
  assert.throws(() => auditKimiAccounting(success(aggregate)));
});
