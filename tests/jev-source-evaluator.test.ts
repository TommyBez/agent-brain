import assert from "node:assert/strict";
import test from "node:test";
import { DEFECT_CONSOLIDATION_QUESTIONS } from "../lib/maintenance/consolidation-defect-questions";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import { JEV_MODEL } from "../lib/maintenance/jev";
import {
  evaluateSourceSupport,
  JEV_SOURCE_QUESTIONS,
  type SourceSupportArm,
} from "../lib/maintenance/jev-source-evaluator";

const input = {
  before: "Sara owns the project.",
  after: "Sara acquired the project on October 4.",
  evidence: ["Statement on October 4: Sara owns the project."],
  operation: { type: "incorporate_answer" },
};

function response(answer: unknown) {
  return {
    answers: { supported_by_evidence: answer },
    usage: { inputTokens: 500, outputTokens: 0 },
    warnings: [],
    providerMetadata: {
      gateway: { cost: "0.00002", secret: "private source" },
    },
  };
}

test("source-only binary and Choice use public SDK, identical clean state and explicit probability mass", async () => {
  const cases = [
    {
      arm: "binary",
      answer: { type: "boolean", probability: 0.85 },
      risk: 0.85,
    },
    {
      arm: "choice",
      answer: {
        type: "choice",
        choice: "unsupported",
        probabilities: {
          supported: 0.15,
          contradicted: 0.3,
          unsupported: 0.55,
        },
      },
      risk: 0.85,
    },
  ] as const;
  for (const item of cases) {
    let calls = 0;
    const result = await evaluateSourceSupport(
      { ...input, expected: "fail" } as typeof input,
      item.arm,
      {
        apiKey: "test-key",
        fetch: async (url, init) => {
          calls++;
          assert.equal(
            url,
            "https://ai-gateway.vercel.sh/v4/ai/evaluation-model",
          );
          assert.equal(
            new Headers(init?.headers).get("ai-model-id"),
            JEV_MODEL,
          );
          assert.equal(init?.cache, "no-store");
          assert.ok(init?.signal);
          const request = JSON.parse(String(init?.body));
          assert.deepEqual(request.state, input);
          assert.deepEqual(request.questions, JEV_SOURCE_QUESTIONS[item.arm]);
          if (item.arm === "binary")
            assert.deepEqual(
              request.questions.supported_by_evidence,
              DEFECT_CONSOLIDATION_QUESTIONS.supported_by_evidence,
            );
          return Response.json(response(item.answer));
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(result.arm, item.arm);
    assert.ok(Math.abs(result.risk - item.risk) < 1e-12);
    assert.deepEqual(result.answer, item.answer);
    assert.deepEqual(result.usage, {
      inputTokens: 500,
      outputTokens: 0,
      totalTokens: 500,
      gateway: { cost: 0.00002 },
    });
    assert.equal("confidence" in result.answer, false);
    assert.equal(JSON.stringify(result).includes("private source"), false);
  }
});

test("unusable source distributions and degraded responses fail safely without retries or warning logs", async (t) => {
  t.mock.method(process, "emitWarning", () =>
    assert.fail("Provider warnings must not be logged"),
  );
  const invalid: Array<{ arm: SourceSupportArm; body: unknown }> = [
    {
      arm: "choice",
      body: response({ type: "choice", choice: "unsupported" }),
    },
    {
      arm: "choice",
      body: response({
        type: "choice",
        choice: "unsupported",
        probabilities: { supported: 0.1, unsupported: 0.9 },
      }),
    },
    {
      arm: "choice",
      body: response({
        type: "choice",
        choice: "unsupported",
        probabilities: { supported: 0.1, contradicted: 0.2, unsupported: 0.9 },
      }),
    },
    {
      arm: "choice",
      body: response({
        type: "choice",
        choice: "supported",
        probabilities: { supported: 0.1, contradicted: 0.2, unsupported: 0.7 },
      }),
    },
    {
      arm: "binary",
      body: {
        ...response({ type: "boolean", probability: 0.5 }),
        warnings: [
          {
            type: "unsupported",
            feature: "criteria",
            details: "test-key private source",
          },
        ],
      },
    },
  ];
  for (const item of invalid) {
    let calls = 0;
    await assert.rejects(
      evaluateSourceSupport(input, item.arm, {
        apiKey: "test-key",
        fetch: async () => {
          calls++;
          return Response.json(item.body);
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof GatewayRequestError);
        assert.equal(
          error.message,
          "Jev returned an invalid source evaluation response.",
        );
        assert.equal(error.retryable, false);
        assert.equal("cause" in error, false);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});
