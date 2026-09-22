import assert from "node:assert/strict";
import test from "node:test";
import { DEFECT_CONSOLIDATION_QUESTIONS } from "../lib/maintenance/consolidation-defect-questions";
import { applyPositiveConsolidationPolicy } from "../lib/maintenance/consolidation-policy";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import {
  evaluateConsolidationProposal,
  JEV_CONSOLIDATION_THRESHOLDS,
  JEV_MODEL,
} from "../lib/maintenance/jev";

const input = {
  before: "Brain uses PostgreSQL. Brain uses PostgreSQL.",
  after: "Brain uses PostgreSQL.",
  evidence: ["Brain uses PostgreSQL."],
  operation: { type: "remove_duplicate" },
};

function validResponse() {
  return {
    answers: Object.fromEntries(
      Object.keys(JEV_CONSOLIDATION_THRESHOLDS).map((name) => [
        name,
        { type: "boolean", probability: 0.99 },
      ]),
    ),
    usage: { inputTokens: 1500, outputTokens: 0 },
    warnings: [],
    providerMetadata: {
      gateway: {
        cost: "0.00006",
        marketCost: 0.00006,
        secret: "private source",
      },
    },
  };
}

test("Jev uses the public SDK and retains only raw answers and safe audit fields", async () => {
  let requests = 0;
  const enrichedInput = { ...input, expected: "private reference label" };
  const result = await evaluateConsolidationProposal(enrichedInput, {
    apiKey: "test-key",
    fetch: async (url, init) => {
      requests++;
      assert.equal(url, "https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer test-key");
      assert.equal(headers.get("ai-model-id"), JEV_MODEL);
      assert.equal(
        headers.get("ai-evaluation-model-specification-version"),
        "4",
      );
      assert.equal(headers.get("ai-gateway-protocol-version"), "0.0.1");
      assert.match(headers.get("user-agent") ?? "", /ai\/7\./);
      const request = JSON.parse(String(init?.body));
      assert.deepEqual(request.state, input);
      assert.deepEqual(
        Object.keys(request.questions),
        Object.keys(JEV_CONSOLIDATION_THRESHOLDS),
      );
      assert.ok(init?.signal);
      return Response.json(validResponse());
    },
  });
  assert.equal(requests, 1);
  assert.deepEqual(Object.keys(result).sort(), ["answers", "model", "usage"]);
  assert.equal(result.model, JEV_MODEL);
  assert.deepEqual(result.usage, {
    inputTokens: 1500,
    outputTokens: 0,
    totalTokens: 1500,
    gateway: { cost: 0.00006, marketCost: 0.00006 },
  });
  assert.equal(JSON.stringify(result).includes("private source"), false);
});

test("the explicit positive policy retains all four historical threshold boundaries", async () => {
  for (const [name, threshold] of Object.entries(
    JEV_CONSOLIDATION_THRESHOLDS,
  )) {
    for (const probability of [threshold, threshold - 0.01]) {
      const response = validResponse();
      response.answers[name].probability = probability;
      const raw = await evaluateConsolidationProposal(input, {
        apiKey: "test-key",
        fetch: async () => Response.json(response),
      });
      const result = applyPositiveConsolidationPolicy(raw);
      assert.equal(result.allowed, probability >= threshold, name);
      assert.equal(result.reasons.length, probability >= threshold ? 0 : 1);
      assert.equal(result.answers[name], probability);
    }
  }
});

test("defect questions return their true probabilities without the positive decision", async () => {
  const body = validResponse();
  for (const answer of Object.values(body.answers)) answer.probability = 0.01;
  const result = await evaluateConsolidationProposal(input, {
    apiKey: "test-key",
    questions: DEFECT_CONSOLIDATION_QUESTIONS,
    fetch: async (_url, init) => {
      assert.deepEqual(
        JSON.parse(String(init?.body)).questions,
        DEFECT_CONSOLIDATION_QUESTIONS,
      );
      return Response.json(body);
    },
  });
  assert.deepEqual(
    result.answers,
    Object.fromEntries(Object.keys(body.answers).map((key) => [key, 0.01])),
  );
  assert.equal("allowed" in result, false);
  assert.equal("reasons" in result, false);
});

test("malformed or incomplete answers and degraded provider contracts fail closed", async (t) => {
  t.mock.method(process, "emitWarning", () =>
    assert.fail("Provider warnings must not be logged"),
  );
  for (const change of [
    (body: ReturnType<typeof validResponse>) => {
      delete body.answers.supported_by_evidence;
    },
    (body: ReturnType<typeof validResponse>) => {
      body.answers.supported_by_evidence.probability = 1.1;
    },
    (body: ReturnType<typeof validResponse>) => {
      body.answers.supported_by_evidence.probability = -0.01;
    },
    (body: ReturnType<typeof validResponse>) => {
      body.answers.supported_by_evidence.type = "score";
    },
    (body: ReturnType<typeof validResponse>) => {
      body.answers.unrequested = { type: "boolean", probability: 1 };
    },
  ]) {
    const body = validResponse();
    change(body);
    await assert.rejects(
      evaluateConsolidationProposal(input, {
        apiKey: "test-key",
        fetch: async () => Response.json(body),
      }),
      /invalid evaluation response/,
    );
  }
  await assert.rejects(
    evaluateConsolidationProposal(input, {
      apiKey: "test-key",
      fetch: async () =>
        Response.json({
          ...validResponse(),
          warnings: [
            {
              type: "unsupported",
              feature: "criteria",
              details: "private source",
            },
          ],
        }),
    }),
    /invalid evaluation response/,
  );
});

test("Jev failures expose only safe diagnostics and transient retry information", async () => {
  for (const status of [401, 429, 503]) {
    let requests = 0;
    await assert.rejects(
      evaluateConsolidationProposal(input, {
        apiKey: "test-key",
        fetch: async () => {
          requests++;
          return Response.json(
            { error: "private source test-key" },
            { status, headers: { "retry-after": "2" } },
          );
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof GatewayRequestError);
        assert.equal(error.status, status);
        assert.equal(error.retryable, status !== 401);
        assert.equal(error.retryAfterMs, 2000);
        assert.equal(error.message, `Jev returned HTTP ${status}.`);
        return true;
      },
    );
    assert.equal(requests, 1, "The runner owns retries, not the SDK");
  }
  await assert.rejects(
    evaluateConsolidationProposal(input, {
      apiKey: "test-key",
      fetch: async () => {
        throw new Error("private source test-key");
      },
    }),
    { message: "Jev request failed or timed out.", retryable: true },
  );
  await assert.rejects(
    evaluateConsolidationProposal(input, {
      apiKey: "test-key",
      fetch: async () => new Response("private source test-key"),
    }),
    { message: "Jev returned invalid JSON.", retryable: true },
  );
});

test("missing credentials never send a request", async () => {
  await assert.rejects(
    evaluateConsolidationProposal(input, {
      apiKey: "",
      fetch: async () => {
        assert.fail("No unauthenticated request is allowed");
      },
    }),
    { message: "AI_GATEWAY_API_KEY is required for Jev.", retryable: false },
  );
});
