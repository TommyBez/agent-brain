import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { CONSOLIDATION_CRITERIA } from "../lib/maintenance/consolidation-rubric";
import { buildFilterContract } from "../scripts/prepare-filter-contract";

function fixture() {
  const before =
    "# Porto\nLuca guida Porto. Luca guida Porto.\nFonte: [Ruoli](decision/ruoli).";
  const after = "# Porto\nLuca guida Porto.\nFonte: [Ruoli](decision/ruoli).";
  return {
    version: 1,
    scope: "jev-kimi-only",
    scenarios: [
      {
        scenarioId: "C01",
        title: "Deduplicazione",
        target: {
          pageId: "project/porto",
          version: 1,
          title: "Porto",
          type: "project",
          summary: "",
          markdown: before,
        },
        sources: [
          {
            pageId: "decision/ruoli",
            version: 1,
            title: "Ruoli",
            markdown: "Luca guida Porto.",
          },
        ],
        rules: [
          {
            id: "R1",
            description: "Conservare il ruolo.",
            evidence: [
              { pageId: "decision/ruoli", quote: "Luca guida Porto." },
            ],
          },
        ],
        candidates: [
          {
            designId: "C01-V1",
            label: "Deduplicazione valida",
            afterMarkdown: after,
            expectedDecision: "accept",
            expectedCriteria: Object.fromEntries(
              CONSOLIDATION_CRITERIA.map((key) => [
                key,
                {
                  verdict: "pass",
                  rationale:
                    "Fatto invariato, fonte conservata, duplicazione eliminata.",
                },
              ]),
            ),
            rationale: "Elimina la ripetizione.",
            proof: [{ location: "after", quote: "Luca guida Porto." }],
          },
          {
            designId: "C01-V2",
            label: "Richiesta umana",
            afterMarkdown: `${after}\nChiedere a Luca di confermare.`,
            expectedDecision: "reject",
            expectedCriteria: {
              no_new_human_action: {
                verdict: "fail",
                rationale: "Aggiunge una richiesta.",
              },
            },
            rationale: "Crea lavoro umano.",
            contrastWith: "C01-V1",
            proof: [
              { location: "after", quote: "Chiedere a Luca di confermare." },
            ],
          },
        ],
      },
    ],
  };
}

test("fixed proposals produce deterministic isolated model inputs and a partial reference", () => {
  const built = buildFilterContract(fixture());
  assert.deepEqual(buildFilterContract(fixture()), built);
  assert.equal(built.manifestSummary.expectedAccept, 1);
  assert.equal(built.manifestSummary.expectedReject, 1);
  for (const item of built.inputs.cases) {
    assert.deepEqual(Object.keys(item.input), [
      "before",
      "after",
      "evidence",
      "operation",
    ]);
    assert.equal(
      item.inputHash,
      createHash("sha256").update(JSON.stringify(item.input)).digest("hex"),
    );
    assert.match(item.caseId, /^Q\d{2}$/);
    assert.doesNotMatch(
      JSON.stringify(item.input),
      /expectedDecision|expectedCriteria|designId|contrastWith|Deduplicazione valida/,
    );
  }
  const rejected = built.reference.cases.find(
    (item) => item.expectedDecision === "reject",
  );
  assert.deepEqual(Object.keys(rejected?.expectedCriteria ?? {}), [
    "no_new_human_action",
  ]);
  assert.equal(built.reference.missingCriterionPolicy, "not_scored");
  assert.match(built.reviewMarkdown, /Chiedere a Luca di confermare/);
});

test("a reference cannot claim a verbatim proof absent from its proposal", () => {
  const broken = fixture();
  broken.scenarios[0].candidates[1].proof[0].quote = "Una frase mai presente.";
  assert.throws(
    () => buildFilterContract(broken),
    /Candidate proof is not verbatim/,
  );
});
