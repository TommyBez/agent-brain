import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateJev,
  JevResponseError,
  type JevResponseFailure,
  parseEvaluation,
} from "../lib/maintenance/consolidator/jev";
import type { EvaluationRequest } from "../lib/maintenance/consolidator/types";

const request: EvaluationRequest = {
  state: { text: "Un documento italiano." },
  questions: {
    supported: {
      type: "boolean",
      instructions: "Does text support the claim?",
    },
    target: {
      type: "choice",
      instructions: "Which target is established by text?",
      criteria: { a: "The first target", none: "No target" },
    },
  },
};

function response() {
  return {
    model: "typesafe-ai/jev",
    answers: {
      supported: { type: "boolean", probability: 0.93 },
      target: {
        type: "choice",
        choice: "a",
        probabilities: { a: 0.92, none: 0.08 },
      },
    },
    usage: { inputTokens: 325, outputTokens: 40 },
    providerMetadata: {
      typesafe: { confidence: { target: 0.84 } },
      gateway: { cost: "0.00001" },
    },
  };
}

test("Jev calls the evaluation endpoint and retains probabilities, provider confidence and usage", async (t) => {
  const oldKey = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "test-only-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = oldKey;
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(url), "https://ai-gateway.vercel.sh/v1/evaluate");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model: "typesafe-ai/jev",
        ...request,
      });
      return Response.json(response());
    },
  );
  const evaluation = await evaluateJev(request);
  assert.deepEqual(evaluation.answers.target, {
    type: "choice",
    choice: "a",
    probabilities: { a: 0.92, none: 0.08 },
    confidence: 0.84,
  });
  assert.equal(evaluation.inputTokens, 325);
  assert.equal(evaluation.outputTokens, 40);
  assert.deepEqual(evaluation.providerMetadata, response().providerMetadata);
});

test("Jev does not substitute selected probability for unavailable confidence or zero for unavailable usage", () => {
  const raw = { model: "typesafe-ai/jev", answers: response().answers };
  const evaluation = parseEvaluation(request, raw);
  assert.equal(
    evaluation.answers.target.type === "choice" &&
      evaluation.answers.target.confidence,
    null,
  );
  assert.equal(evaluation.inputTokens, null);
  assert.equal(evaluation.outputTokens, null);
});

test("Jev fails closed on missing, unknown, mismatched, and malformed answers", () => {
  const invalid = [
    { ...response(), answers: { supported: response().answers.supported } },
    {
      ...response(),
      answers: {
        ...response().answers,
        unknown: { type: "boolean", probability: 1 },
      },
    },
    {
      ...response(),
      answers: {
        ...response().answers,
        supported: { type: "boolean", probability: 1.1 },
      },
    },
    {
      ...response(),
      answers: {
        ...response().answers,
        supported: { type: "boolean", probability: "1" },
      },
    },
    {
      ...response(),
      answers: { ...response().answers, supported: { type: "noul", noul: 1 } },
    },
    {
      ...response(),
      answers: {
        ...response().answers,
        target: {
          type: "choice",
          choice: "unknown",
          probabilities: { a: 0.92, none: 0.08 },
        },
      },
    },
    {
      ...response(),
      answers: {
        ...response().answers,
        target: { type: "choice", choice: "a", probabilities: { a: 0.92 } },
      },
    },
    {
      ...response(),
      answers: {
        ...response().answers,
        target: {
          type: "choice",
          choice: "a",
          probabilities: { a: 0.1, none: 0.9 },
        },
      },
    },
    {
      ...response(),
      answers: {
        ...response().answers,
        target: {
          type: "choice",
          choice: "a",
          probabilities: { a: 0.9, none: 0.9 },
        },
      },
    },
    {
      ...response(),
      providerMetadata: { typesafe: { confidence: { target: 8 } } },
    },
  ];
  for (const raw of invalid)
    assert.throws(
      () => parseEvaluation(request, raw),
      /invalid evaluation response/,
    );
});

test("Jev transport errors do not become model judgments or expose response bodies", async (t) => {
  const oldKey = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "test-only-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = oldKey;
  });
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("PRIVATE SOURCE TEXT", {
        status: 429,
        headers: { "Retry-After": "2" },
      }),
  );
  await assert.rejects(evaluateJev(request), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /HTTP 429/);
    assert.doesNotMatch(error.message, /PRIVATE/);
    assert.equal(
      (error as Error & { retryAfterMs: number }).retryAfterMs,
      2000,
    );
    return true;
  });
});

test("Jev protocol failures identify the failed contract without exposing inputs or response values", () => {
  const cases: { raw: unknown; reason: JevResponseFailure }[] = [
    { raw: { model: "PRIVATE SOURCE TEXT" }, reason: "envelope_shape" },
    { raw: { ...response(), answers: {} }, reason: "answer_keys" },
    {
      raw: {
        ...response(),
        answers: {
          ...response().answers,
          supported: { type: "boolean", probability: "PRIVATE SOURCE TEXT" },
        },
      },
      reason: "boolean_shape",
    },
    {
      raw: {
        ...response(),
        answers: {
          ...response().answers,
          target: {
            type: "choice",
            choice: "PRIVATE SOURCE TEXT",
            probabilities: null,
          },
        },
      },
      reason: "choice_shape",
    },
    {
      raw: {
        ...response(),
        answers: {
          ...response().answers,
          target: {
            type: "choice",
            choice: "PRIVATE SOURCE TEXT",
            probabilities: { a: 0.9, none: 0.1 },
          },
        },
      },
      reason: "choice_keys",
    },
    {
      raw: {
        ...response(),
        answers: {
          ...response().answers,
          target: {
            type: "choice",
            choice: "a",
            probabilities: { a: 0.8, none: 0.15 },
          },
        },
      },
      reason: "choice_mass",
    },
    {
      raw: {
        ...response(),
        answers: {
          ...response().answers,
          target: {
            type: "choice",
            choice: "a",
            probabilities: { a: 0.4, none: 0.6 },
          },
        },
      },
      reason: "choice_not_max",
    },
    {
      raw: {
        ...response(),
        providerMetadata: {
          typesafe: { confidence: { target: "PRIVATE SOURCE TEXT" } },
        },
      },
      reason: "confidence",
    },
  ];
  for (const { raw, reason } of cases) {
    assert.throws(
      () => parseEvaluation(request, raw),
      (error: unknown) => {
        assert.ok(error instanceof JevResponseError);
        assert.equal(error.reason, reason);
        assert.equal(
          error.message,
          `Jev returned an invalid evaluation response. [${reason}]`,
        );
        assert.doesNotMatch(error.message, /PRIVATE SOURCE TEXT/);
        return true;
      },
    );
  }
});

test("Jev retains observed cent-rounded choice distributions without normalization", () => {
  const cases = [
    { same: 0.37, insufficient: 0.04, different: 0.56, none: 0.02 },
    { none: 0.67, equivalent: 0.02, insufficient: 0.13, a: 0.01, b: 0.16 },
    { a: 0.6, b: 0.21, c: 0.1, d: 0.1 },
  ];
  for (const probabilities of cases) {
    const choice = Object.entries(probabilities).sort(
      (a, b) => b[1] - a[1],
    )[0][0];
    const roundedRequest: EvaluationRequest = {
      state: "Synthetic rounding compatibility check.",
      questions: {
        selected: {
          type: "choice",
          instructions: "Select the supported option.",
          criteria: Object.fromEntries(
            Object.keys(probabilities).map((id) => [id, id]),
          ),
        },
      },
    };
    const evaluation = parseEvaluation(roundedRequest, {
      model: "typesafe-ai/jev",
      answers: { selected: { type: "choice", choice, probabilities } },
    });
    assert.equal(evaluation.answers.selected.type, "choice");
    if (evaluation.answers.selected.type !== "choice")
      throw new Error("Expected choice");
    assert.deepEqual(evaluation.answers.selected.probabilities, probabilities);
    assert.equal(evaluation.answers.selected.choice, choice);
  }
});

test("Jev rejects non-quantized or excessive mass errors and still rejects wrong choice winners", () => {
  const invalid = [
    {
      choice: "a",
      probabilities: { a: 0.8001, none: 0.19 },
      reason: "choice_mass",
    },
    {
      choice: "a",
      probabilities: { a: 0.8, none: 0.15 },
      reason: "choice_mass",
    },
    { choice: "a", probabilities: { a: 0, none: 0 }, reason: "choice_mass" },
    {
      choice: "a",
      probabilities: { a: 0.4, none: 0.59 },
      reason: "choice_not_max",
    },
  ];
  for (const { choice, probabilities, reason } of invalid) {
    assert.throws(
      () =>
        parseEvaluation(request, {
          ...response(),
          answers: {
            ...response().answers,
            target: { type: "choice", choice, probabilities },
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof JevResponseError);
        assert.equal(error.reason, reason);
        return true;
      },
    );
  }
});
