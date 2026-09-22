import assert from "node:assert/strict";
import test from "node:test";
import {
  CONSOLIDATION_CRITERIA,
  CONSOLIDATION_QUESTIONS_V2,
  type ConsolidationCriterion,
} from "../lib/maintenance/consolidation-rubric";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import {
  evaluateWithKimi,
  KIMI_EVALUATOR_SETTINGS,
  KIMI_MODEL,
  KimiResponseError,
} from "../lib/maintenance/kimi-evaluator";

const input = {
  before: "Brain usa PostgreSQL. Brain usa PostgreSQL.",
  after: "Brain usa PostgreSQL.",
  evidence: [{ path: "fonte.md", markdown: "Brain usa PostgreSQL." }],
  operation: { type: "remove_duplicate", rationale: "Elimina ripetizione." },
};
const allCriteria = [...CONSOLIDATION_CRITERIA];

function validResponse(criteria: ConsolidationCriterion[] = allCriteria) {
  return {
    id: "chatcmpl-kimi_123",
    model: KIMI_MODEL,
    choices: [
      {
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify(
            Object.fromEntries(
              criteria.map((criterion, index) => [
                criterion,
                {
                  verdict: ["pass", "fail", "uncertain"][index % 3],
                  rationale: "La frase su PostgreSQL rimane in after.",
                },
              ]),
            ),
          ),
          reasoning_content: "DO_NOT_RETAIN_PRIVATE_REASONING",
          reasoning: "DO_NOT_RETAIN_PRIVATE_REASONING",
          refusal: null as unknown,
          tool_calls: undefined as unknown,
        },
      },
    ],
    usage: {
      prompt_tokens: 200,
      completion_tokens: 120,
      total_tokens: 320,
      completion_tokens_details: { reasoning_tokens: 90 },
      prompt_tokens_details: { cached_tokens: 50 },
      cost: undefined as unknown,
      private: "DO_NOT_RETAIN_PRIVATE_USAGE",
    },
    providerMetadata: {
      gateway: {
        cost: "0.00123" as unknown,
        marketCost: 44,
        secret: "DO_NOT_RETAIN_PRIVATE_METADATA",
      },
    },
  };
}

test("Kimi requests the selected judgments with the same full input and V2 rubric", async () => {
  for (const criteria of [
    allCriteria,
    [allCriteria[1]],
    allCriteria.slice(2),
  ]) {
    let requests = 0;
    const result = await evaluateWithKimi(
      {
        ...input,
        ...{
          jev: "FORBIDDEN_JEV_SCORES",
          bands: "FORBIDDEN_BANDS",
          routingReason: "FORBIDDEN_ROUTING_REASON",
          expectedLabels: "FORBIDDEN_EXPECTED_LABELS",
          previousResponses: "FORBIDDEN_PREVIOUS_RESPONSE",
        },
      },
      criteria,
      {
        apiKey: "unit-test-key",
        fetch: async (url, init) => {
          requests++;
          assert.equal(url, KIMI_EVALUATOR_SETTINGS.endpoint);
          assert.equal(init?.method, "POST");
          assert.equal(init?.cache, "no-store");
          assert.ok(init?.signal);
          assert.equal(
            new Headers(init?.headers).get("authorization"),
            "Bearer unit-test-key",
          );
          const body = JSON.parse(String(init?.body));
          assert.equal(body.model, "moonshotai/kimi-k3");
          assert.equal(body.max_tokens, 8192);
          assert.equal(body.stream, false);
          assert.equal(body.temperature, undefined);
          assert.equal(body.reasoning_effort, undefined);
          assert.deepEqual(body.reasoning, { effort: "high", exclude: true });
          assert.equal(body.messages.length, 2);
          assert.equal(body.messages[0].role, "system");
          assert.match(body.messages[0].content, /untrusted data/);
          assert.match(
            body.messages[0].content,
            /SOLO sui criteri selezionati/,
          );
          assert.ok(
            body.messages[0].content.includes(
              JSON.stringify(CONSOLIDATION_QUESTIONS_V2),
            ),
          );
          assert.equal(body.messages[1].role, "user");
          assert.deepEqual(JSON.parse(body.messages[1].content), input);
          assert.equal(JSON.stringify(body).includes("FORBIDDEN_"), false);
          assert.equal(body.response_format.type, "json_schema");
          assert.equal(body.response_format.json_schema.strict, true);
          const schema = body.response_format.json_schema.schema;
          assert.equal(schema.additionalProperties, false);
          assert.deepEqual(schema.required, criteria);
          assert.deepEqual(Object.keys(schema.properties), criteria);
          for (const criterion of criteria) {
            assert.equal(
              schema.properties[criterion].additionalProperties,
              false,
            );
            assert.deepEqual(schema.properties[criterion].required, [
              "verdict",
              "rationale",
            ]);
            assert.deepEqual(
              schema.properties[criterion].properties.verdict.enum,
              ["pass", "fail", "uncertain"],
            );
          }
          return Response.json(validResponse(criteria));
        },
      },
    );
    assert.equal(requests, 1);
    assert.deepEqual(Object.keys(result.judgments), criteria);
    assert.equal(result.model, KIMI_MODEL);
    assert.equal(result.responseModel, KIMI_MODEL);
    assert.equal(result.responseId, "chatcmpl-kimi_123");
    assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
    assert.deepEqual(result.usage, {
      inputTokens: 200,
      outputTokens: 120,
      totalTokens: 320,
      reasoningTokens: 90,
      cachedInputTokens: 50,
      costUsd: 0.00123,
    });
    assert.equal(JSON.stringify(result).includes("DO_NOT_RETAIN_"), false);
  }
});

test("Kimi response must be a single completed assistant message, without refusal", async () => {
  const changes: ((body: ReturnType<typeof validResponse>) => void)[] = [
    (body) => {
      body.choices = [];
    },
    (body) => {
      body.choices.push(body.choices[0]);
    },
    ...["length", "content_filter", "tool_calls", "error", ""].map(
      (reason) => (body: ReturnType<typeof validResponse>) => {
        body.choices[0].finish_reason = reason;
      },
    ),
    (body) => {
      body.choices[0].message.role = "user";
    },
    (body) => {
      body.choices[0].message.refusal = "DO_NOT_RETAIN_REFUSAL";
    },
    (body) => {
      body.choices[0].message.tool_calls = [{ function: "DO_NOT_RETAIN_TOOL" }];
    },
    (body) => {
      body.choices[0].message.content = " ";
    },
    (body) => {
      body.choices[0].message.content = "{}";
    },
    (body) => {
      body.choices[0].message.content = "[]";
    },
    (body) => {
      body.choices[0].message.content = "```json\n{}\n```";
    },
    (body) => {
      body.choices[0].message.content = '{"supported_by_evidence":';
    },
  ];
  for (const change of changes) {
    const body = validResponse();
    change(body);
    let requests = 0;
    await assert.rejects(
      evaluateWithKimi(input, allCriteria, {
        apiKey: "test-key",
        fetch: async () => {
          requests++;
          return Response.json(body);
        },
      }),
      {
        message: "Kimi returned an invalid evaluation response.",
        retryable: false,
      },
    );
    assert.equal(requests, 1);
  }
});

test("Kimi rejects extra/missing criteria, extra fields, invalid verdicts and rationales", async () => {
  const criterion = "preserves_distinct_information";
  for (const judgments of [
    {},
    { [criterion]: { verdict: "pass", rationale: "Conservato." }, other: {} },
    { supported_by_evidence: { verdict: "pass", rationale: "Conservato." } },
    { [criterion]: { verdict: "yes", rationale: "Conservato." } },
    { [criterion]: { verdict: true, rationale: "Conservato." } },
    { [criterion]: { verdict: "pass", rationale: " " } },
    { [criterion]: { verdict: "pass", rationale: 3 } },
    { [criterion]: { verdict: "pass", rationale: "x".repeat(1001) } },
    { [criterion]: { verdict: "pass" } },
    {
      [criterion]: {
        verdict: "pass",
        rationale: "Conservato.",
        reasoning: "x",
      },
    },
    { [criterion]: ["pass", "Conservato."] },
  ]) {
    const body = validResponse([criterion]);
    body.choices[0].message.content = JSON.stringify(judgments);
    await assert.rejects(
      evaluateWithKimi(input, [criterion], {
        apiKey: "test-key",
        fetch: async () => Response.json(body),
      }),
      {
        message: "Kimi returned an invalid evaluation response.",
        retryable: false,
      },
    );
  }
});

test("Kimi malformed-answer diagnostics retain usage without retaining private content", async () => {
  const criterion = allCriteria[0];
  const cases = [
    {
      content: "PRIVATE_CONTENT not JSON",
      stage: "content",
      reason: "invalid_json",
    },
    { content: "{}", stage: "judgments", reason: "missing_keys" },
    {
      content: JSON.stringify({
        [criterion]: { verdict: "pass", rationale: "PRIVATE_RATIONALE" },
        PRIVATE_EXTRA: {},
      }),
      stage: "judgments",
      reason: "extra_keys",
    },
    {
      content: JSON.stringify({ PRIVATE_EXTRA: {} }),
      stage: "judgments",
      reason: "missing_and_extra_keys",
    },
    {
      content: JSON.stringify({
        [criterion]: {
          verdict: "pass",
          rationale: "PRIVATE_RATIONALE".repeat(80),
        },
      }),
      stage: "judgment",
      reason: "rationale_too_long",
    },
    {
      content: "PRIVATE_TRUNCATED_CONTENT",
      finishReason: "length",
      stage: "completion",
      reason: "output_truncated",
    },
    {
      content: "PRIVATE_CONTENT",
      finishReason: "PRIVATE_UNKNOWN_REASON",
      stage: "completion",
      reason: "invalid_finish_reason",
      unsafeIdentifiers: true,
    },
  ];
  for (const item of cases) {
    const body = validResponse([criterion]);
    body.choices[0].message.content = item.content;
    body.choices[0].finish_reason = item.finishReason ?? "stop";
    if (item.unsafeIdentifiers) {
      body.id = "PRIVATE ID";
      body.model = "PRIVATE MODEL";
    }
    await assert.rejects(
      evaluateWithKimi(input, [criterion], {
        apiKey: "PRIVATE_KEY",
        fetch: async () =>
          Response.json(body, {
            headers: { "x-private": "PRIVATE_HEADER" },
          }),
      }),
      (error: unknown) => {
        assert.ok(error instanceof GatewayRequestError);
        assert.ok(error instanceof KimiResponseError);
        assert.equal(error.stage, item.stage);
        assert.equal(error.reasonCode, item.reason);
        assert.equal(error.retryable, false);
        assert.equal(error.responseId, item.unsafeIdentifiers ? null : body.id);
        assert.equal(
          error.responseModel,
          item.unsafeIdentifiers ? null : KIMI_MODEL,
        );
        assert.ok(Number.isFinite(error.latencyMs) && error.latencyMs >= 0);
        assert.deepEqual(error.usage, {
          inputTokens: 200,
          outputTokens: 120,
          totalTokens: 320,
          reasoningTokens: 90,
          cachedInputTokens: 50,
          costUsd: 0.00123,
        });
        assert.deepEqual(Object.keys(error).sort(), [
          "latencyMs",
          "name",
          "reasonCode",
          "responseId",
          "responseModel",
          "retryAfterMs",
          "retryable",
          "stage",
          "status",
          "usage",
        ]);
        assert.equal(JSON.stringify(error).includes("PRIVATE"), false);
        assert.equal(error.stack?.includes("PRIVATE"), false);
        return true;
      },
    );
  }
});

test("Kimi only retains valid numeric usage, explicit cost and safe identifiers", async () => {
  const body = validResponse();
  body.id = "chatcmpl-123\nDO_NOT_RETAIN_HEADER";
  body.model = "DO_NOT_RETAIN_PRIVATE MODEL";
  body.usage.prompt_tokens = -1;
  body.usage.completion_tokens = 0.5;
  body.usage.total_tokens = Number.MAX_SAFE_INTEGER + 1;
  body.usage.prompt_tokens_details.cached_tokens = -5;
  body.usage.completion_tokens_details.reasoning_tokens = -2;
  body.providerMetadata.gateway.cost = null;
  const result = await evaluateWithKimi(input, allCriteria, {
    apiKey: "test-key",
    fetch: async () => Response.json(body),
  });
  assert.equal(result.responseId, null);
  assert.equal(result.responseModel, null);
  assert.deepEqual(result.usage, {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    reasoningTokens: null,
    cachedInputTokens: null,
    costUsd: null,
  });
  assert.equal(JSON.stringify(result).includes("DO_NOT_RETAIN_"), false);
  body.usage.cost = "0.00042";
  const explicit = await evaluateWithKimi(input, allCriteria, {
    apiKey: "test-key",
    fetch: async () => Response.json(body),
  });
  assert.equal(explicit.usage.costUsd, 0.00042);
});

test("Kimi exposes only safe errors and one attempt for HTTP/transport failures", async () => {
  for (const status of [400, 401, 408, 429, 500, 503]) {
    let requests = 0;
    await assert.rejects(
      evaluateWithKimi(input, allCriteria, {
        apiKey: "SECRET_TEST_KEY",
        fetch: async () => {
          requests++;
          return new Response("SECRET_TEST_KEY PRIVATE_PROMPT", {
            status,
            headers: { "retry-after": "2" },
          });
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof GatewayRequestError);
        assert.equal(error.message, `Kimi returned HTTP ${status}.`);
        assert.equal(error.status, status);
        assert.equal(
          error.retryable,
          status === 408 || status === 429 || status >= 500,
        );
        assert.equal(error.retryAfterMs, 2000);
        assert.equal(JSON.stringify(error).includes("SECRET_TEST_KEY"), false);
        assert.equal(JSON.stringify(error).includes("PRIVATE_PROMPT"), false);
        return true;
      },
    );
    assert.equal(requests, 1);
  }
  await assert.rejects(
    evaluateWithKimi(input, allCriteria, {
      apiKey: "SECRET_TEST_KEY",
      fetch: async () => {
        throw new Error("SECRET_TEST_KEY PRIVATE_PROMPT");
      },
    }),
    { message: "Kimi request failed or timed out.", retryable: true },
  );
  await assert.rejects(
    evaluateWithKimi(input, allCriteria, {
      apiKey: "SECRET_TEST_KEY",
      fetch: async () => new Response("SECRET_TEST_KEY PRIVATE_PROMPT"),
    }),
    { message: "Kimi returned invalid JSON.", retryable: false },
  );
});

test("invalid criteria, missing credentials and unserializable input never send", async () => {
  const noFetch = async () => assert.fail("No request is permitted");
  for (const criteria of [[], [allCriteria[0], allCriteria[0]], ["invented"]]) {
    await assert.rejects(
      evaluateWithKimi(input, criteria as ConsolidationCriterion[], {
        apiKey: "test-key",
        fetch: noFetch,
      }),
      { message: "Kimi evaluation criteria are invalid.", retryable: false },
    );
  }
  await assert.rejects(
    evaluateWithKimi(input, allCriteria, { apiKey: " ", fetch: noFetch }),
    { message: "AI_GATEWAY_API_KEY is required for Kimi.", retryable: false },
  );
  for (const before of [BigInt(1), undefined]) {
    await assert.rejects(
      evaluateWithKimi({ ...input, before }, allCriteria, {
        apiKey: "test-key",
        fetch: noFetch,
      }),
      {
        message: "Kimi evaluation input is not serializable.",
        retryable: false,
      },
    );
  }
});

test("Kimi snapshots criterion selection and caps timeout to 120 seconds", async (t) => {
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    deadlines.push(milliseconds);
    return new AbortController().signal;
  });
  const criteria: ConsolidationCriterion[] = [allCriteria[0]];
  const result = await evaluateWithKimi(input, criteria, {
    apiKey: "test-key",
    timeoutMs: 240_000,
    fetch: async () => {
      const body = validResponse(criteria);
      criteria.push(allCriteria[1]);
      return Response.json(body);
    },
  });
  assert.deepEqual(Object.keys(result.judgments), [allCriteria[0]]);
  assert.deepEqual(deadlines, [120_000]);
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      evaluateWithKimi(input, allCriteria, {
        apiKey: "test-key",
        timeoutMs,
        fetch: async () => assert.fail("Invalid timeout must not send"),
      }),
      { message: "Kimi evaluation timeout is invalid.", retryable: false },
    );
  }
});
