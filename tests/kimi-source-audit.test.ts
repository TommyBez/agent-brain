import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateWithKimi,
  KimiResponseError,
} from "../lib/maintenance/kimi-evaluator";
import {
  type SourceClaim,
  sourceAuditContext,
} from "../lib/maintenance/kimi-source-audit";
import { evaluateWithKimiSourceContract } from "../lib/maintenance/kimi-source-contract";

const input = {
  before: "## Progetto\n\nIl proprietario non è registrato.",
  after: "## Progetto\n\nSara ha acquisito il progetto il 4 ottobre 2026.",
  evidence: [
    {
      markdown:
        "Dichiarazione del 4 ottobre 2026: Sara è proprietaria del progetto.",
    },
  ],
  operation: { rationale: "Questa motivazione non è una fonte." },
};
const claim: SourceClaim = {
  afterQuote: "Sara ha acquisito il progetto il 4 ottobre 2026.",
  fact: "Sara ha acquisito il progetto.",
  temporal: "4 ottobre 2026 come data dell'acquisizione.",
  attribution: "",
  quantifier: "",
  evidence: [
    { source: "/evidence/0/markdown", quote: input.evidence[0].markdown },
  ],
  checks: {
    fact: "unsupported",
    temporal: "unsupported",
    attribution: "not_applicable",
    quantifier: "not_applicable",
  },
  finding:
    "La fonte data una dichiarazione di titolarità, non l'evento di acquisizione.",
};

async function evaluate(
  audit: unknown,
  verdict: "pass" | "fail" | "uncertain",
  state = input,
) {
  return evaluateWithKimi(state, ["supported_by_evidence"], {
    apiKey: "test-key",
    auditSourceSupport: true,
    fetch: async () =>
      Response.json({
        usage: { prompt_tokens: 10, completion_tokens: 20 },
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                supported_by_evidence: {
                  audit,
                  verdict,
                  rationale: "Giudizio basato sulle associazioni documentate.",
                },
              }),
            },
          },
        ],
      }),
  });
}

test("the source ledger preserves factual date roles and covers only changed blocks", async () => {
  assert.deepEqual(sourceAuditContext(input).units, [
    { id: "u1", text: claim.afterQuote },
  ]);
  const rejected = await evaluate([{ unitId: "u1", claims: [claim] }], "fail");
  assert.equal(rejected.judgments.supported_by_evidence?.verdict, "fail");
  assert.equal(
    rejected.sourceAudit?.[0].claims[0].checks.temporal,
    "unsupported",
  );

  const validInput = {
    ...input,
    after:
      "## Progetto\n\nSara è proprietaria del progetto, secondo la dichiarazione del 4 ottobre 2026.",
  };
  const validClaim: SourceClaim = {
    ...claim,
    afterQuote: validInput.after.split("\n\n")[1],
    fact: "Sara è proprietaria del progetto.",
    temporal: "4 ottobre 2026 come data della dichiarazione.",
    checks: { ...claim.checks, fact: "supported", temporal: "supported" },
    finding:
      "La data resta associata alla dichiarazione; non viene inventata una decorrenza.",
  };
  assert.equal(
    (
      await evaluate(
        [{ unitId: "u1", claims: [validClaim] }],
        "pass",
        validInput,
      )
    ).judgments.supported_by_evidence?.verdict,
    "pass",
  );
  const removal = {
    ...input,
    before: "Fatto noto.\n\nFatto noto.",
    after: "Fatto noto.",
  };
  assert.deepEqual(sourceAuditContext(removal).units, []);
  assert.equal((await evaluate([], "pass", removal)).sourceAudit?.length, 0);
  const headingInput = { ...input, before: "## Prima", after: "## Dopo" };
  const nonFactual: SourceClaim = {
    ...claim,
    afterQuote: "## Dopo",
    fact: "Intestazione di sezione, non un'affermazione fattuale.",
    temporal: "",
    attribution: "",
    quantifier: "",
    evidence: [],
    checks: {
      fact: "not_applicable",
      temporal: "not_applicable",
      attribution: "not_applicable",
      quantifier: "not_applicable",
    },
    finding:
      "Nessuna informazione fattuale aggiunta; l'utilità appartiene a un altro criterio.",
  };
  assert.equal(
    (
      await evaluate(
        [{ unitId: "u1", claims: [nonFactual] }],
        "pass",
        headingInput,
      )
    ).judgments.supported_by_evidence?.verdict,
    "pass",
  );
  const inherited = sourceAuditContext({
    ...input,
    before:
      "# Registro\n\n## Nel controllo del 5 maggio\n\nIl processo archivia i dati.",
    after:
      "# Registro\n\n## In ogni controllo del 5 e 6 maggio\n\nIl processo archivia i dati.",
  });
  assert.equal(inherited.units.length, 2);
  assert.equal(inherited.units[1].text, "Il processo archivia i dati.");
  assert.ok(inherited.units[1].contextChange);
  assert.ok(
    inherited.units[1].contextChange.after.includes(
      "## In ogni controllo del 5 e 6 maggio",
    ),
  );
});

test("invented evidence, omitted changed words and internally contradictory approvals fail closed", async () => {
  const cases = [
    {
      audit: [{ unitId: "u1", claims: [claim] }],
      verdict: "pass",
      reason: "inconsistent_source_verdict",
    },
    {
      audit: [
        {
          unitId: "u1",
          claims: [
            {
              ...claim,
              evidence: [
                {
                  source: "/evidence/0/markdown",
                  quote: "Acquisizione avvenuta il 4 ottobre 2026.",
                },
              ],
            },
          ],
        },
      ],
      verdict: "fail",
      reason: "invalid_source_citation",
    },
    {
      audit: [
        {
          unitId: "u1",
          claims: [
            {
              ...claim,
              evidence: [
                {
                  source: "/operation/rationale",
                  quote: input.operation.rationale,
                },
              ],
            },
          ],
        },
      ],
      verdict: "fail",
      reason: "invalid_source_citation",
    },
    { audit: [], verdict: "pass", reason: "incomplete_source_audit" },
    {
      audit: [
        {
          unitId: "u1",
          claims: [{ ...claim, afterQuote: "Sara ha acquisito il progetto" }],
        },
      ],
      verdict: "fail",
      reason: "incomplete_source_audit",
    },
    {
      audit: [
        {
          unitId: "u1",
          claims: [
            {
              ...claim,
              temporal: "",
            },
          ],
        },
      ],
      verdict: "fail",
      reason: "inconsistent_source_verdict",
    },
    {
      audit: [
        {
          unitId: "u1",
          claims: [
            {
              ...claim,
              checks: {
                ...claim.checks,
                fact: "ambiguous",
                temporal: "ambiguous",
              },
            },
          ],
        },
      ],
      verdict: "pass",
      reason: "inconsistent_source_verdict",
    },
  ] as const;
  for (const entry of cases) {
    await assert.rejects(
      evaluate(entry.audit, entry.verdict),
      (error: unknown) => {
        assert.ok(error instanceof KimiResponseError);
        assert.equal(error.stage, "source_audit");
        assert.equal(error.reasonCode, entry.reason);
        assert.equal(error.usage.inputTokens, 10);
        assert.equal(JSON.stringify(error).includes("Sara"), false);
        return true;
      },
    );
  }
});

test("preservation distinguishes evidence available to the judge from a link retained for the reader", async () => {
  const before =
    "Fatto documentato. [Verbale](event/verbale). [Copia del verbale](event/verbale).";
  const evidence = [
    { markdown: "Fatto documentato.", pageId: "event/verbale" },
  ];
  const run = (after: string, verdict: "pass" | "fail") =>
    evaluateWithKimiSourceContract(
      { before, after, evidence, operation: { type: "consolidate_passage" } },
      ["preserves_distinct_information"],
      "clarified",
      {
        apiKey: "test-key",
        fetch: async (_url, init) => {
          const state = JSON.parse(
            JSON.parse(String(init?.body)).messages[1].content,
          );
          assert.equal(state.sourceAudit, undefined);
          assert.deepEqual(state.preservationLinks.before, ["event/verbale"]);
          return Response.json({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    preserves_distinct_information: {
                      verdict,
                      rationale: "Riscontro del collegamento finale.",
                    },
                  }),
                },
              },
            ],
          });
        },
      },
    );
  const result = await run("Fatto documentato.", "fail");
  assert.deepEqual(result.preservationAudit?.removed, ["event/verbale"]);
  await assert.rejects(run("Fatto documentato.", "pass"), (error: unknown) => {
    assert.ok(error instanceof KimiResponseError);
    assert.equal(error.reasonCode, "inconsistent_preservation_verdict");
    return true;
  });
  const kept = await run(
    "Fatto documentato. [Verbale](event/verbale).",
    "pass",
  );
  assert.deepEqual(kept.preservationAudit?.removed, []);
  assert.equal(kept.judgments.preserves_distinct_information?.verdict, "pass");
});
