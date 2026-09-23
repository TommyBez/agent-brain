import assert from "node:assert/strict";
import test from "node:test";
import type { ConsolidationCriterion } from "../lib/maintenance/consolidation-rubric";
import type { ConsolidationEvaluationInput } from "../lib/maintenance/jev";
import { KimiResponseError } from "../lib/maintenance/kimi-evaluator";
import {
  type SourceAuditErrorReason,
  SourceAuditValidationError,
  sourceAuditContext,
} from "../lib/maintenance/kimi-source-audit";
import { validateSourceChallenge } from "../lib/maintenance/kimi-source-challenge";
import { evaluateWithKimiSourceContract } from "../lib/maintenance/kimi-source-contract";

const input = {
  before: "La data di acquisizione non è documentata.",
  after: "Sara ha acquisito il progetto il 4 ottobre 2026.",
  evidence: [
    {
      markdown:
        "Dichiarazione del 4 ottobre 2026: Sara è proprietaria del progetto.",
    },
  ],
  operation: { type: "resolve_answered_question" },
};
const evidence = [
  { source: "/evidence/0/markdown", quote: input.evidence[0].markdown },
];
const association = {
  fact: "Sara acquisisce il progetto",
  date: "4 ottobre 2026",
  dateRole: "data di acquisizione",
  source: "dichiarazione",
  sourceRole: "attesta uno stato di proprietà",
  quantifier: "",
  evidence,
  status: "unsupported",
  alternative:
    "L'acquisizione può precedere la dichiarazione senza contraddire la proprietà alla data documentata.",
};
const challenge = {
  supported_by_evidence: {
    associations: [{ unitId: "u1", associations: [association] }],
    rationale:
      "La data dell'evento non è implicata dalla data della dichiarazione.",
  },
};
const response = (content: unknown) =>
  Response.json({
    model: "moonshotai/kimi-k3",
    id: "chatcmpl-single-review",
    usage: {
      prompt_tokens: 10,
      completion_tokens: 15,
      total_tokens: 25,
      cost: 0.01,
    },
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: JSON.stringify(content) },
      },
    ],
  });
const evaluateContent = (
  content: unknown,
  state: ConsolidationEvaluationInput = input,
  criteria: ConsolidationCriterion[] = ["supported_by_evidence"],
) =>
  evaluateWithKimiSourceContract(state, criteria, "clarified", {
    apiKey: "test-key",
    fetch: async () => response(content),
  });

test("one mixed review derives support from associations and retains the other selected judgment and one cost", async () => {
  let calls = 0;
  const result = await evaluateWithKimiSourceContract(
    {
      ...input,
      ...{
        jev: "FORBIDDEN_SCORE",
        previousResponses: "FORBIDDEN_PRIOR",
        expected: "FORBIDDEN_LABEL",
      },
    },
    ["supported_by_evidence", "no_new_human_action"],
    "clarified",
    {
      apiKey: "test-key",
      fetch: async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, "moonshotai/kimi-k3");
        assert.equal(JSON.stringify(body).includes("FORBIDDEN_"), false);
        assert.deepEqual(body.response_format.json_schema.schema.required, [
          "supported_by_evidence",
          "no_new_human_action",
        ]);
        const state = JSON.parse(body.messages[1].content);
        assert.deepEqual(
          {
            before: state.before,
            after: state.after,
            evidence: state.evidence,
            operation: state.operation,
          },
          input,
        );
        assert.match(body.messages[0].content, /controesempio/);
        return response({
          ...challenge,
          no_new_human_action: {
            verdict: "pass",
            rationale: "Nessun compito aggiunto.",
          },
        });
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.judgments.supported_by_evidence?.verdict, "fail");
  assert.equal(result.judgments.no_new_human_action?.verdict, "pass");
  assert.equal(result.sourceAudit, undefined);
  assert.equal(result.reviewReceipts?.length, 1);
  assert.equal(result.reviewReceipts?.[0].review, "single");
  assert.equal(result.reviewReceipts?.[0].judgment?.verdict, "fail");
  assert.equal(result.usage.physicalCalls, 1);
  assert.equal(result.usage.costUsd, 0.01);
  assert.equal(result.usage.inputTokens, 10);
  assert.equal(result.usage.outputTokens, 15);
  assert.equal(result.usage.unknownCostCalls, 0);
});

test("new facts without dates or named sources are reviewed, and pass/fail/uncertain come only from the ledger", async () => {
  const state = {
    before: "Il progetto usa PostgreSQL. Il progetto usa PostgreSQL.",
    after: "Il progetto usa PostgreSQL.",
    evidence: [],
    operation: "deduplicate_passage",
  };
  for (const [status, verdict] of [
    ["entailed", "pass"],
    ["unsupported", "fail"],
    ["ambiguous", "uncertain"],
  ] as const) {
    let calls = 0;
    const row = {
      ...association,
      fact: "Il progetto usa PostgreSQL.",
      date: "",
      dateRole: "",
      source: "",
      sourceRole: "",
      evidence: [{ source: "/before", quote: state.after }],
      status,
      alternative:
        status === "entailed"
          ? ""
          : "Lettura alternativa riportata dal giudice di test.",
    };
    const result = await evaluateWithKimiSourceContract(
      state,
      ["supported_by_evidence"],
      "clarified",
      {
        apiKey: "test-key",
        fetch: async (_url, init) => {
          calls++;
          const body = JSON.parse(String(init?.body));
          assert.match(
            body.messages[0].content,
            /anche quando non contiene date/,
          );
          return response({
            supported_by_evidence: {
              associations: [{ unitId: "u1", associations: [row] }],
              rationale: "Riscontro di test, non un giudizio del provider.",
            },
          });
        },
      },
    );
    assert.equal(result.judgments.supported_by_evidence?.verdict, verdict);
    assert.equal(calls, 1);
  }
});

test("missing units, invented evidence and inconsistent rows remain errors with the paid usage retained", async () => {
  const rows: [Record<string, unknown>, SourceAuditErrorReason][] = [
    [
      {
        ...association,
        evidence: [
          {
            source: "/evidence/0/markdown",
            quote: "Acquisizione avvenuta il 4 ottobre 2026.",
          },
        ],
      },
      "source_challenge_literal_quote",
    ],
    [
      { ...association, evidence: [{ source: "/after", quote: input.after }] },
      "source_challenge_citation",
    ],
    [
      {
        ...association,
        status: "entailed",
        alternative: "Una lettura alternativa esiste.",
      },
      "source_challenge_entailed_consistency",
    ],
    [
      { ...association, status: "entailed", alternative: "", evidence: [] },
      "source_challenge_entailed_consistency",
    ],
    [
      { ...association, alternative: "" },
      "source_challenge_counterexample_required",
    ],
    [{ ...association, dateRole: "" }, "source_challenge_date_role"],
    [{ ...association, sourceRole: "" }, "source_challenge_source_role"],
    [{ ...association, fact: "" }, "source_challenge_fact_required"],
    [{ ...association, status: "PRIVATE_STATUS" }, "source_challenge_status"],
    [{ ...association, evidence: null }, "source_challenge_evidence"],
    [{ ...association, extra: "PRIVATE_FIELD" }, "source_challenge_fields"],
  ];
  const ledgers: [unknown, SourceAuditErrorReason][] = [
    [[], "source_challenge_coverage"],
    [
      [{ unitId: "invented", associations: [association] }],
      "source_challenge_unit",
    ],
    [[{ unitId: "u1", associations: [] }], "source_challenge_associations"],
    ...rows.map(([row, reason]): [unknown, SourceAuditErrorReason] => [
      [{ unitId: "u1", associations: [row] }],
      reason,
    ]),
  ];
  for (const [associations, reasonCode] of ledgers) {
    await assert.rejects(
      evaluateContent({
        supported_by_evidence: { associations, rationale: "PRIVATE_RATIONALE" },
      }),
      (error) => {
        assert.ok(error instanceof KimiResponseError);
        assert.equal(error.stage, "source_challenge");
        assert.equal(error.reasonCode, reasonCode);
        assert.equal(error.usage.physicalCalls, 1);
        assert.equal(error.usage.costUsd, 0.01);
        assert.equal(error.usage.unknownCostCalls, 0);
        assert.equal(error.responseId, "chatcmpl-single-review");
        assert.equal(error.reviewReceipts?.length, 1);
        assert.equal(error.reviewReceipts?.[0].outcome, "error");
        assert.equal(error.reviewReceipts?.[0].reasonCode, reasonCode);
        assert.equal(error.reviewReceipts?.[0].judgment, undefined);
        assert.equal(error.technicalCause?.kind, "invalid_response");
        assert.equal(JSON.stringify(error).includes("PRIVATE_"), false);
        return true;
      },
    );
  }
  await assert.rejects(
    evaluateContent({
      supported_by_evidence: {
        ...challenge.supported_by_evidence,
        verdict: "fail",
      },
    }),
    (error) => {
      assert.ok(error instanceof KimiResponseError);
      assert.equal(error.reasonCode, "extra_keys");
      return true;
    },
  );
});

test("HTTP and transport failures retain one unknown attempt and their technical cause without retrying", async () => {
  for (const status of [402, 503, null]) {
    let calls = 0;
    await assert.rejects(
      evaluateWithKimiSourceContract(
        input,
        ["supported_by_evidence"],
        "clarified",
        {
          apiKey: "test-key",
          fetch: async () => {
            calls++;
            if (status === null) throw new Error("PRIVATE_TRANSPORT_DETAILS");
            return new Response("PRIVATE_PROVIDER_BODY", {
              status,
              headers: { "retry-after": "2" },
            });
          },
        },
      ),
      (error) => {
        assert.ok(error instanceof KimiResponseError);
        assert.equal(error.stage, "request");
        assert.equal(error.reasonCode, "request_unavailable");
        assert.equal(error.usage.physicalCalls, 1);
        assert.equal(error.usage.costUsd, null);
        assert.equal(error.usage.inputTokens, null);
        assert.equal(error.usage.unknownCostCalls, 1);
        assert.equal(error.usage.unknownTokenCalls, 1);
        assert.deepEqual(error.technicalCause, {
          kind: status === null ? "transport_or_configuration" : "http",
          status,
          retryable: status !== 402,
          retryAfterMs: status === null ? null : 2000,
        });
        assert.equal(error.reviewReceipts?.length, 1);
        assert.deepEqual(
          error.reviewReceipts?.[0].technicalCause,
          error.technicalCause,
        );
        assert.equal(JSON.stringify(error).includes("PRIVATE_"), false);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("a changed heading keeps inherited text in the source review and omitted contextual units fail", async () => {
  const state = {
    before:
      "# Registro\n\n## Nel controllo del 5 maggio\n\nIl processo archivia i dati.",
    after:
      "# Registro\n\n## In ogni controllo del 5 e 6 maggio\n\nIl processo archivia i dati.",
    evidence: [],
    operation: "consolidate_passage",
  };
  const context = sourceAuditContext(state);
  assert.equal(context.units.length, 2);
  const inherited = context.units.find(
    (unit) => unit.text === "Il processo archivia i dati.",
  );
  assert.ok(inherited?.contextChange);
  const associations = context.units.map((unit) => ({
    unitId: unit.id,
    associations: [
      {
        ...association,
        fact: "Archiviazione a ogni controllo",
        date: "6 maggio",
        dateRole: "osservazione",
        source: "",
        sourceRole: "",
        quantifier: "ogni controllo",
        evidence: [
          { source: "/before", quote: "## Nel controllo del 5 maggio" },
        ],
        alternative: "Il testo documenta soltanto il controllo del 5 maggio.",
      },
    ],
  }));
  let calls = 0;
  const result = await evaluateWithKimiSourceContract(
    state,
    ["supported_by_evidence"],
    "clarified",
    {
      apiKey: "test-key",
      fetch: async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        assert.match(body.messages[0].content, /contextChange/);
        assert.deepEqual(
          JSON.parse(body.messages[1].content).sourceAudit.units,
          context.units,
        );
        return response({
          supported_by_evidence: {
            associations,
            rationale: "L'intestazione estende l'associazione.",
          },
        });
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.judgments.supported_by_evidence?.verdict, "fail");
  await assert.rejects(
    evaluateContent(
      {
        supported_by_evidence: {
          associations: associations.slice(0, 1),
          rationale: "Riscontro incompleto.",
        },
      },
      state,
    ),
    (error) => {
      assert.ok(error instanceof KimiResponseError);
      assert.equal(error.reasonCode, "source_challenge_coverage");
      return true;
    },
  );
});

test("a mixed source review cannot override the deterministic removal of the last source link", async () => {
  const state = {
    before: "Fatto noto. [Fonte](event/fonte).",
    after: "Fatto noto.",
    evidence: [],
    operation: "consolidate_passage",
  };
  const content = {
    supported_by_evidence: {
      associations: [
        {
          unitId: "u1",
          associations: [
            {
              ...association,
              fact: "Fatto noto.",
              date: "",
              dateRole: "",
              source: "",
              sourceRole: "",
              evidence: [{ source: "/before", quote: state.after }],
              status: "entailed",
              alternative: "",
            },
          ],
        },
      ],
      rationale: "Il fatto rimane documentato.",
    },
    preserves_distinct_information: {
      verdict: "fail",
      rationale: "L'unico link alla fonte è stato eliminato.",
    },
  };
  const selected: ConsolidationCriterion[] = [
    "supported_by_evidence",
    "preserves_distinct_information",
  ];
  const result = await evaluateContent(content, state, selected);
  assert.equal(result.judgments.supported_by_evidence?.verdict, "pass");
  assert.equal(
    result.judgments.preserves_distinct_information?.verdict,
    "fail",
  );
  assert.deepEqual(result.preservationAudit?.removed, ["event/fonte"]);
  content.preserves_distinct_information.verdict = "pass";
  await assert.rejects(evaluateContent(content, state, selected), (error) => {
    assert.ok(error instanceof KimiResponseError);
    assert.equal(error.reasonCode, "inconsistent_preservation_verdict");
    assert.equal(error.usage.physicalCalls, 1);
    return true;
  });
});

test("separate passages must be separate literal citations, never joined by invented ellipsis", () => {
  const before =
    "## Review — 16 September\n\nFirst observation.\n\n## Review — 17 September\n\nSecond observation.";
  const context = sourceAuditContext({
    ...input,
    before,
    after: "Reviews on 16–17 September.",
    evidence: [],
  });
  const row = {
    ...association,
    fact: "Review dates",
    date: "16–17 September",
    dateRole: "review dates",
    source: "",
    sourceRole: "",
    status: "entailed",
    alternative: "",
    evidence: [
      {
        source: "/before",
        quote: "## Review — 16 September ... ## Review — 17 September",
      },
    ],
  };
  assert.throws(
    () =>
      validateSourceChallenge([{ unitId: "u1", associations: [row] }], context),
    /source audit is invalid/,
  );
  row.evidence = [
    { source: "/before", quote: "## Review — 16 September" },
    { source: "/before", quote: "## Review — 17 September" },
  ];
  assert.equal(
    validateSourceChallenge([{ unitId: "u1", associations: [row] }], context)
      .verdict,
    "pass",
  );
});

test("a repeated unit id has a different diagnostic from incomplete unit coverage", () => {
  const context = {
    ...sourceAuditContext(input),
    units: [
      { id: "u1", text: "First changed statement." },
      { id: "u2", text: "Second changed statement." },
    ],
  };
  const unit = { unitId: "u1", associations: [association] };
  for (const [raw, reasonCode] of [
    [[unit], "source_challenge_coverage"],
    [[unit, unit], "source_challenge_duplicate_unit"],
  ] as const) {
    assert.throws(
      () => validateSourceChallenge(raw, context),
      (error) => {
        assert.ok(error instanceof SourceAuditValidationError);
        assert.equal(error.reasonCode, reasonCode);
        return true;
      },
    );
  }
});
