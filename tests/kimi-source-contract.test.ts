import assert from "node:assert/strict";
import test from "node:test";
import type { ConsolidationCriterion } from "../lib/maintenance/consolidation-rubric";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import {
  evaluateWithKimi,
  KIMI_MODEL,
  KimiResponseError,
} from "../lib/maintenance/kimi-evaluator";
import { KIMI_SOURCE_AUDIT_INSTRUCTIONS } from "../lib/maintenance/kimi-source-audit";
import {
  evaluateWithKimiSourceContract,
  KIMI_SOURCE_CONTRACT,
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
    const body = JSON.parse(String(init.body));
    const state = JSON.parse(body.messages[1].content);
    const schema = body.response_format.json_schema.schema;
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
                  criterion === "supported_by_evidence" &&
                  schema.properties[criterion].properties.associations
                    ? {
                        associations: state.sourceAudit.units.map(
                          (unit: { id: string; text: string }) => ({
                            unitId: unit.id,
                            associations: [
                              {
                                fact: unit.text,
                                date: "",
                                dateRole: "",
                                source: "",
                                sourceRole: "",
                                quantifier: "",
                                evidence: [
                                  { source: "/before", quote: unit.text },
                                ],
                                status: "entailed",
                                alternative: "",
                              },
                            ],
                          }),
                        ),
                        rationale: "La rimozione non aggiunge affermazioni.",
                      }
                    : {
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

test("clarified support and preservation share one request without a separate source verdict or primary audit", async () => {
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
  assert.ok(
    after.messages[0].content.includes(KIMI_SOURCE_CONTRACT_CLARIFICATION),
  );
  assert.equal(
    after.messages[0].content.includes(KIMI_SOURCE_AUDIT_INSTRUCTIONS),
    false,
  );
  assert.match(
    after.messages[0].content,
    /altri criteri selezionati restituisci verdict e rationale/,
  );
  const supportSchema =
    after.response_format.json_schema.schema.properties.supported_by_evidence;
  assert.deepEqual(supportSchema.required, ["associations", "rationale"]);
  assert.equal(supportSchema.properties.audit, undefined);
  assert.equal(supportSchema.properties.verdict, undefined);
  assert.deepEqual(
    after.response_format.json_schema.schema.properties
      .preserves_distinct_information,
    before.response_format.json_schema.schema.properties
      .preserves_distinct_information,
  );
  const state = JSON.parse(after.messages[1].content);
  assert.deepEqual(state.sourceAudit.units, [{ id: "u1", text: input.after }]);
  assert.deepEqual(state.preservationLinks.removed, []);
  assert.equal(clarified.sourceAudit, undefined);
  assert.equal(clarified.sourceChallenge?.length, 1);
  assert.deepEqual(baseline.judgments, original.judgments);
  assert.deepEqual(clarified.judgments, original.judgments);
  assert.equal(clarified.usage.physicalCalls, 1);
  assert.equal(clarified.usage.costUsd, null);
  assert.equal(clarified.usage.unknownCostCalls, 1);
  assert.equal(clarified.usage.unknownTokenCalls, 1);
  assert.equal(clarified.reviewReceipts?.length, 1);
  assert.equal(clarified.reviewReceipts?.[0].review, "single");
  assert.equal(KIMI_SOURCE_CONTRACT.physicalCalls, 1);
});

test("without source support the original selected-criteria prompt and response contract remain unchanged", async () => {
  const selected: ConsolidationCriterion[] = [
    "no_new_human_action",
    "meaningful_improvement",
  ];
  const { requests, options } = captureRequests(selected);
  await evaluateWithKimi(input, selected, options);
  await evaluateWithKimiSourceContract(input, selected, "baseline", options);
  const result = await evaluateWithKimiSourceContract(
    input,
    selected,
    "clarified",
    options,
  );
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(requests[2], requests[0]);
  assert.equal(
    String(requests[2].init.body).includes(KIMI_SOURCE_CONTRACT_CLARIFICATION),
    false,
  );
  assert.equal(result.judgments.supported_by_evidence, undefined);
  assert.equal(result.sourceChallenge, undefined);
  assert.equal(result.reviewReceipts?.length, 1);
  assert.equal(result.reviewReceipts?.[0].judgment, undefined);
});

test("invalid input before sending does not create an attempted-call receipt", async () => {
  for (const value of [
    { criteria: [] as ConsolidationCriterion[], input },
    {
      criteria: ["supported_by_evidence"] as ConsolidationCriterion[],
      input: { ...input, before: undefined },
    },
  ]) {
    await assert.rejects(
      evaluateWithKimiSourceContract(value.input, value.criteria, "clarified", {
        apiKey: "test-key",
        fetch: async () => assert.fail("Local invalid input must not send"),
      }),
      (error) => {
        assert.ok(error instanceof GatewayRequestError);
        assert.equal(error instanceof KimiResponseError, false);
        assert.equal("reviewReceipts" in error, false);
        return true;
      },
    );
  }
});
