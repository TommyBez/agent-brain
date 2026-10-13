import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  failureDiagnostic,
  failureMessage,
} from "../lib/maintenance/consolidator/diagnostics";
import { evaluateJev } from "../lib/maintenance/consolidator/jev";
import type { EvaluationRequest } from "../lib/maintenance/consolidator/types";
import { GatewayRequestError } from "../lib/maintenance/gateway";

const capacityResponse = {
  error: { message: "private provider message" },
  providerMetadata: {
    gateway: {
      routing: {
        modelAttempts: [
          {
            providerAttempts: [
              {
                provider: "typesafe-ai",
                statusCode: 400,
                error: JSON.stringify({
                  error_type: "max_tokens_exceeded",
                  message: "private source text",
                }),
              },
              { provider: "digitalocean", statusCode: 400, error: "HTTP 400" },
            ],
          },
        ],
      },
    },
  },
};
const request: EvaluationRequest = {
  state: { text: "Complete source, including its final paragraph." },
  questions: Object.fromEntries(
    ["a", "b", "c", "d"].map((id) => [
      id,
      {
        type: "choice" as const,
        instructions: `Select the supported counterpart for ${id}.`,
        criteria: { first: "First passage", none: "No counterpart" },
      },
    ]),
  ),
};

function setup(t: TestContext) {
  const oldKey = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "test-only";
  t.after(() => {
    if (oldKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = oldKey;
  });
}

test("provider capacity failures split recursively without dropping state, questions, choices or audit metadata", async (t) => {
  setup(t);
  const sizes: number[] = [];
  const completed: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as EvaluationRequest;
      assert.deepEqual(body.state, request.state);
      const ids = Object.keys(body.questions);
      sizes.push(ids.length);
      for (const id of ids)
        assert.deepEqual(body.questions[id], request.questions[id]);
      if (ids.length > 1)
        return Response.json(capacityResponse, { status: 400 });
      const id = ids[0];
      completed.push(id);
      return Response.json({
        model: "typesafe-ai/jev",
        answers: {
          [id]: {
            type: "choice",
            choice: "first",
            probabilities: { first: 0.9, none: 0.1 },
          },
        },
        usage: { inputTokens: 100, outputTokens: 20 },
        providerMetadata: { typesafe: { confidence: { [id]: 0.8 } } },
      });
    },
  );
  const result = await evaluateJev(request);
  assert.deepEqual(sizes, [4, 2, 1, 1, 2, 1, 1]);
  assert.deepEqual(completed, ["a", "b", "c", "d"]);
  assert.deepEqual(Object.keys(result.answers), completed);
  for (const answer of Object.values(result.answers))
    assert.deepEqual(answer, {
      type: "choice",
      choice: "first",
      probabilities: { first: 0.9, none: 0.1 },
      confidence: 0.8,
    });
  assert.equal(result.inputTokens, 400);
  assert.equal(result.outputTokens, 80);
  assert.deepEqual(result.providerMetadata, {
    batches: [
      {
        batches: [
          { typesafe: { confidence: { a: 0.8 } } },
          { typesafe: { confidence: { b: 0.8 } } },
        ],
      },
      {
        batches: [
          { typesafe: { confidence: { c: 0.8 } } },
          { typesafe: { confidence: { d: 0.8 } } },
        ],
      },
    ],
  });
});

test("a single oversized question stops with a safe diagnostic that survives Workflow serialization", async (t) => {
  setup(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json(capacityResponse, { status: 400 });
  });
  await assert.rejects(
    evaluateJev({ ...request, questions: { a: request.questions.a } }),
    (error: unknown) => {
      assert.ok(error instanceof GatewayRequestError);
      assert.equal(error.status, 400);
      assert.equal(error.retryable, false);
      const diagnostic = failureDiagnostic(error);
      assert.equal(diagnostic.code, "max_tokens_exceeded");
      assert.deepEqual(
        failureDiagnostic(new Error(failureMessage(diagnostic))),
        diagnostic,
      );
      assert.doesNotMatch(JSON.stringify(error), /private|source text/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("unrelated, malformed and oversized HTTP 400 bodies never trigger splitting", async (t) => {
  setup(t);
  const bodies = [
    JSON.stringify({ error: { message: "max_tokens_exceeded private text" } }),
    "not JSON",
    " ".repeat(64 * 1024) + JSON.stringify(capacityResponse),
  ];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    const body = bodies[calls++];
    return new Response(body, { status: 400 });
  });
  for (let index = 0; index < bodies.length; index++) {
    await assert.rejects(evaluateJev(request), (error: unknown) => {
      assert.ok(error instanceof GatewayRequestError);
      assert.equal(error.reason, "http_400");
      return true;
    });
    assert.equal(calls, index + 1);
  }
});

test("split evaluations preserve unknown usage and never return a partial success", async (t) => {
  setup(t);
  let failSecond = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      const { questions } = JSON.parse(String(init.body)) as EvaluationRequest;
      const ids = Object.keys(questions);
      if (ids.length > 1)
        return Response.json(capacityResponse, { status: 400 });
      if (ids[0] === "b" && failSecond)
        return new Response("provider unavailable", { status: 503 });
      return Response.json({
        model: "typesafe-ai/jev",
        answers: {
          [ids[0]]: {
            type: "choice",
            choice: "none",
            probabilities: { first: 0.1, none: 0.9 },
          },
        },
        ...(ids[0] === "a"
          ? { usage: { inputTokens: 100, outputTokens: 20 } }
          : {}),
      });
    },
  );
  const pair = {
    ...request,
    questions: { a: request.questions.a, b: request.questions.b },
  };
  const result = await evaluateJev(pair);
  assert.equal(result.inputTokens, null);
  assert.equal(result.outputTokens, null);
  failSecond = true;
  await assert.rejects(evaluateJev(pair), (error: unknown) => {
    assert.ok(error instanceof GatewayRequestError);
    assert.equal(error.status, 503);
    assert.equal(error.retryable, true);
    return true;
  });
});
