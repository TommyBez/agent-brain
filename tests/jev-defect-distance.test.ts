import assert from "node:assert/strict";
import test from "node:test";
import { CONSOLIDATION_CRITERIA as criteria } from "../lib/maintenance/consolidation-rubric";
import {
  type DefectAnalysisCase,
  mapArms,
  mapCriteria,
  selectThresholds,
} from "../lib/maintenance/defect-threshold-method";
import { analyzeDefectScores } from "../scripts/analyze-jev-defects";

test("boundary neighborhoods include a score exactly .01 from .07 without changing routing", () => {
  const row = (
    caseId: string,
    verdict: "pass" | "fail",
    risk: number,
  ): DefectAnalysisCase => ({
    caseId,
    familyId: caseId,
    split: "calibration",
    referenceCriteria: mapCriteria(() => ({
      verdict,
      rationale: "Toy reference.",
    })),
    receipts: mapArms((arm) =>
      [1, 2, 3].map((repeat) => ({
        repeat,
        outcome: "success",
        risks: mapCriteria(() => risk),
        rawScores: mapCriteria(() =>
          arm === "positive" ? Number((1 - risk).toFixed(12)) : risk,
        ),
      })),
    ),
  });
  const good = row("good", "pass", 0.06);
  const bad = row("bad", "fail", 0.07);
  const selected = selectThresholds([good, bad]);
  assert.equal(selected.defect[criteria[0]].dual.allowBelow, 0.07);
  assert.equal(selected.defect[criteria[0]].dual.rejectAtOrAbove, 0.07);
  const probe = row("probe", "fail", 0.08);
  const result = analyzeDefectScores([probe], selected, false);
  const criterion = result.arms.defect.byCriterion[criteria[0]];
  const nearby = criterion.position.nearBoundaries.find(
    (item) => item.distance === 0.01,
  );
  assert.equal(nearby?.allow.length, 3);
  assert.equal(nearby?.reject.length, 3);
  assert.equal(criterion.frozen.total.rejected, 3);
  assert.equal(criterion.frozen.total.allowed, 0);
});
