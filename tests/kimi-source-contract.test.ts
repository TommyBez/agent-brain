import assert from "node:assert/strict";
import test from "node:test";
import type { ConsolidationCriterion } from "../lib/maintenance/consolidation-rubric";
import {
  evaluateWithKimi,
  KIMI_MODEL,
} from "../lib/maintenance/kimi-evaluator";
import {
  evaluateWithKimiSourceContract,
  KIMI_SOURCE_CONTRACT_CLARIFICATION,
} from "../lib/maintenance/kimi-source-contract";

const input = {
  before: "Il progetto usa PostgreSQL. Il progetto usa PostgreSQL.",
  after: "Il progetto usa PostgreSQL.",
  evidence: [],
  operation: { type: "remove_duplicate" },
};

function captureRequests(criteria: ConsolidationCriterion[]) {
  const requests: { url: unknown; init: Omit<RequestInit, "signal"> }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    assert.ok(init?.signal);
    const { signal: _signal, ...rest } = init;
    requests.push({ url, init: rest });
    return Response.json({
      model: KIMI_MODEL,
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify(
              Object.fromEntries(
                criteria.map((criterion) => [
                  criterion,
                  {
                    verdict: "pass",
                    rationale: "La rimozione non aggiunge affermazioni.",
                  },
                ]),
              ),
            ),
          },
        },
      ],
    });
  };
  return { requests, options: { apiKey: "unit-test-key", fetch } };
}

test("source contract changes only the system clarification and retains the existing response contract", async () => {
  const selected: ConsolidationCriterion[] = [
    "supported_by_evidence",
    "preserves_distinct_information",
  ];
  const { requests, options } = captureRequests(selected);
  const original = await evaluateWithKimi(input, selected, options);
  const baseline = await evaluateWithKimiSourceContract(
    input,
    selected,
    "baseline",
    options,
  );
  const clarified = await evaluateWithKimiSourceContract(
    input,
    selected,
    "clarified",
    options,
  );

  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1], requests[0]);
  const before = JSON.parse(String(requests[1].init.body));
  const after = JSON.parse(String(requests[2].init.body));
  assert.equal(
    after.messages[0].content,
    `${before.messages[0].content}\n\n${KIMI_SOURCE_CONTRACT_CLARIFICATION}`,
  );
  after.messages[0].content = before.messages[0].content;
  assert.deepEqual(
    {
      ...requests[2],
      init: { ...requests[2].init, body: JSON.stringify(after) },
    },
    requests[1],
  );
  assert.deepEqual(baseline.judgments, original.judgments);
  assert.deepEqual(clarified.judgments, original.judgments);
  assert.deepEqual(clarified.usage, original.usage);
});

test("the clarification is absent when source support is not selected", async () => {
  const selected: ConsolidationCriterion[] = ["no_new_human_action"];
  const { requests, options } = captureRequests(selected);
  await evaluateWithKimi(input, selected, options);
  await evaluateWithKimiSourceContract(input, selected, "baseline", options);
  await evaluateWithKimiSourceContract(input, selected, "clarified", options);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(requests[2], requests[0]);
  assert.equal(
    String(requests[2].init.body).includes(KIMI_SOURCE_CONTRACT_CLARIFICATION),
    false,
  );
});
