import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CONSOLIDATION_QUESTIONS_V2,
  CONSOLIDATION_CRITERIA as criteria,
} from "../lib/maintenance/consolidation-rubric";
import {
  type DefectAnalysisCase,
  decideDefectRisk,
  mapArms,
  mapCriteria,
  type Observation,
  receiptRisk,
  selectCriterionThresholds,
  selectThresholds,
} from "../lib/maintenance/defect-threshold-method";
import { JEV_MODEL } from "../lib/maintenance/jev";
import {
  analyzeDefectScores,
  runDefectAnalysis,
  simulateDefectProposals,
} from "../scripts/analyze-jev-defects";
import {
  defectHash,
  hashDefectText,
  runDefects,
} from "../scripts/evaluate-jev-defects";

function obs(
  reference: Observation["reference"],
  risks: number[],
  caseId = reference,
): Observation[] {
  return risks.map((risk, index) => ({
    caseId,
    familyId: "family",
    repeat: index + 1,
    reference,
    risk,
  }));
}
function row(
  caseId: string,
  reference: "pass" | "fail",
  risks: [number, number, number],
): DefectAnalysisCase {
  return {
    caseId,
    familyId: caseId,
    source: "toy",
    split: "calibration",
    referenceCriteria: mapCriteria(() => ({
      verdict: reference,
      rationale: "Toy reference.",
    })),
    receipts: mapArms((arm) =>
      risks.map((risk, index) => ({
        repeat: index + 1,
        outcome: "success",
        risks: mapCriteria(() => risk),
        rawScores: mapCriteria(() =>
          arm === "positive" ? Number((1 - risk).toFixed(12)) : risk,
        ),
      })),
    ),
  };
}

test("selection optimizes automation then the widest conservative band; single objectives differ", () => {
  const result = selectCriterionThresholds([
    ...obs("pass", [0.1, 0.1, 0.1]),
    ...obs("fail", [0.9, 0.9, 0.9]),
  ]);
  assert.deepEqual(result.dual, { allowBelow: 0.11, rejectAtOrAbove: 0.9 });
  assert.deepEqual(result.single, { defectFirst: 0.9, lowFalseAlarms: 0.11 });
  assert.equal(result.calibration.automatic, 6);
});

test("all repetition extremes and uncertain references constrain decisions", () => {
  const result = selectCriterionThresholds([
    ...obs("pass", [0.1, 0.8, 0.1]),
    ...obs("fail", [0.9, 0.2, 0.9]),
    ...obs("uncertain", [0.15, 0.4, 0.85]),
  ]);
  assert.deepEqual(result.dual, { allowBelow: 0.11, rejectAtOrAbove: 0.9 });
  assert.equal(result.calibration.defectsMissed, 0);
  assert.equal(result.calibration.goodBlocked, 0);
  assert.equal(result.calibration.uncertainDecided, 0);
  assert.deepEqual(result.single, { defectFirst: 0.2, lowFalseAlarms: 0.81 });
});

test("absent class coverage disables all automatic decisions", () => {
  const result = selectCriterionThresholds(obs("pass", [0.1, 0.2, 0.3]));
  assert.equal(result.missingCoverage, true);
  assert.deepEqual(result.dual, { allowBelow: 0, rejectAtOrAbove: 1.01 });
  assert.deepEqual(result.single, { defectFirst: null, lowFalseAlarms: null });
});

test("band boundaries and complement decimals have exact declared semantics", () => {
  const band = { allowBelow: 0.1, rejectAtOrAbove: 0.8 };
  assert.equal(decideDefectRisk(0.09, band), "allow");
  assert.equal(decideDefectRisk(0.1, band), "defer");
  assert.equal(decideDefectRisk(0.8, band), "reject");
  assert.equal(decideDefectRisk(null, band), "error");
  const receipt = row("good", "pass", [0.1, 0.1, 0.1]).receipts.positive[0];
  assert.equal(receiptRisk(receipt, "positive", criteria[0]), 0.1);
});

test("threshold selection rejects holdout, missing repetitions and failed outcomes", () => {
  const good = row("good", "pass", [0.1, 0.1, 0.1]);
  const bad = row("bad", "fail", [0.9, 0.9, 0.9]);
  assert.throws(
    () => selectThresholds([{ ...good, split: "validation" }, bad]),
    /calibration rows only/,
  );
  assert.throws(
    () =>
      selectThresholds([
        {
          ...good,
          receipts: {
            ...good.receipts,
            positive: good.receipts.positive.slice(1),
          },
        },
        bad,
      ]),
    /exactly three/,
  );
  good.receipts.defect[0].outcome = "failed";
  assert.throws(() => selectThresholds([good, bad]), /incomplete calibration/);
});

test("proposal gate needs four passes, red wins over gray, errors remain separate", () => {
  const good = row("good", "pass", [0.1, 0.5, 0.9]);
  const bands = mapCriteria(() => ({ allowBelow: 0.2, rejectAtOrAbove: 0.8 }));
  const result = simulateDefectProposals([good], "defect", bands);
  assert.deepEqual(
    result.cases.map((item) => item.decision),
    ["allow", "defer", "reject"],
  );
  assert.equal(result.kimiCalls, 1);
  assert.equal(result.delegatedCriteria, 4);
  good.receipts.defect[2].outcome = "failed";
  assert.equal(simulateDefectProposals([good], "defect", bands).errors, 1);
});

test("analysis retains common samples, all thresholds, crossing and paired complement residuals", () => {
  const good = row("good", "pass", [0.1, 0.1, 0.1]);
  const bad = row("bad", "fail", [0.9, 0.9, 0.9]);
  const selected = selectThresholds([good, bad]);
  good.receipts.defect[1].rawScores = mapCriteria(() => 0.2);
  good.receipts.defect[1].risks = mapCriteria(() => 0.2);
  bad.receipts.negative[2].outcome = "failed";
  const result = analyzeDefectScores([good, bad], selected, false);
  assert.equal(result.commonCompleteCases, 1);
  assert.equal(
    result.arms.defect.byCriterion[criteria[0]].position.unstableCases,
    1,
  );
  assert.equal(
    result.arms.defect.byCriterion[criteria[0]].single.grid.length,
    102,
  );
  assert.equal(
    result.arms.defect.byCriterion[criteria[0]].sensitivity.length,
    12,
  );
  assert.equal(result.complement[criteria[0]].observations, 5);
  assert.equal(
    result.complement[criteria[0]].absoluteComplementResidual.max,
    0,
  );
  assert.equal(
    result.arms.negative.byCriterion[criteria[0]].frozen.total.errors,
    1,
  );
});

test("analysis freezes verified calibration then writes complete immutable holdout outputs without network", async () => {
  const input = await mkdtemp(join(tmpdir(), "jev-defect-analysis-"));
  const save = (name: string, value: unknown) =>
    writeFile(join(input, name), `${JSON.stringify(value, null, 2)}\n`);
  try {
    const cases = Array.from({ length: 3 }, (_, index) => {
      const state = {
        before: { index, text: "Fact. Fact." },
        after: "Fact.",
        evidence: ["Fact."],
        operation: "deduplicate",
      };
      return {
        caseId: `case-${index}`,
        inputHash: defectHash(state),
        input: state,
      };
    });
    const rubric = `${JSON.stringify(CONSOLIDATION_QUESTIONS_V2, null, 2)}\n`;
    const questions = mapArms((arm) =>
      mapCriteria((key) =>
        arm === "positive"
          ? CONSOLIDATION_QUESTIONS_V2[key]
          : {
              ...CONSOLIDATION_QUESTIONS_V2[key],
              instructions: `${arm} toy question ${key}`,
              criteria: {
                true: CONSOLIDATION_QUESTIONS_V2[key].criteria.false,
                false: CONSOLIDATION_QUESTIONS_V2[key].criteria.true,
              },
            },
      ),
    );
    await Promise.all([
      save("cases.json", { cases }),
      writeFile(join(input, "rubric.json"), rubric),
      save("questions.json", questions),
      save("partition.json", {
        cases: cases.map((item, index) => ({
          caseId: item.caseId,
          familyId: `family-${index}`,
          split: index < 2 ? "calibration" : "validation",
          source: "synthetic-new",
          variantId: index % 2 === 0 ? "good" : "bad",
        })),
      }),
      save("subagent-review.json", {
        reviewer: "blind-subagent",
        rubricHash: hashDefectText(rubric),
        candidates: cases.map((item, index) => ({
          caseId: item.caseId,
          inputHash: item.inputHash,
          criteria: mapCriteria(() => ({
            verdict: index % 2 === 0 ? "pass" : "fail",
            rationale: "Frozen toy reference.",
          })),
        })),
      }),
      save("evaluation-spec.json", {
        repetitions: 3,
        expectedCases: { calibration: 2, validation: 1 },
        model: JEV_MODEL,
        designCodeHashes: {},
      }),
    ]);
    const evaluate = async (
      state: { before: unknown },
      options?: { questions?: typeof CONSOLIDATION_QUESTIONS_V2 },
    ) => {
      const bad = (state.before as { index: number }).index % 2 === 1;
      const negative =
        options?.questions?.supported_by_evidence.instructions.startsWith(
          "negative",
        ) ||
        options?.questions?.supported_by_evidence.instructions.startsWith(
          "defect",
        );
      const score = negative ? (bad ? 0.9 : 0.1) : bad ? 0.1 : 0.9;
      return {
        model: JEV_MODEL,
        answers: mapCriteria(() => score),
        allowed: false,
        reasons: [],
        usage: { gateway: { cost: 0 } },
      };
    };
    await runDefects(
      { input, phase: "calibration" },
      { evaluateJev: evaluate },
    );
    await runDefectAnalysis(input, "select");
    const before = await readFile(join(input, "selection.json"), "utf8");
    await runDefects({ input, phase: "validation" }, { evaluateJev: evaluate });
    await runDefectAnalysis(input, "analyze");
    const analysis = JSON.parse(
      await readFile(join(input, "analysis.json"), "utf8"),
    );
    assert.equal(analysis.validation.uniqueCases, 1);
    assert.equal(analysis.validation.arms.defect.proposals.kimiCalls, 0);
    const visual = JSON.parse(
      await readFile(join(input, "visual-data.json"), "utf8"),
    );
    assert.equal(visual.validation[0].risks.defect[criteria[0]][0], 0.1);
    assert.equal(visual.validation[0].reference[criteria[0]], "pass");
    await runDefectAnalysis(input, "analyze");
    assert.equal(await readFile(join(input, "selection.json"), "utf8"), before);
  } finally {
    await rm(input, { recursive: true, force: true });
  }
});
