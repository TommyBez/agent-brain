import assert from "node:assert/strict";
import test from "node:test";
import { CONSOLIDATION_CRITERIA } from "../lib/maintenance/consolidation-rubric";
import {
  assessControlled,
  auc,
  type ControlledCase,
  selectControlledThresholds,
} from "../scripts/analyze-jev-controlled";

function item(
  caseId: string,
  reference: "pass" | "fail" | "uncertain",
  scores: number[],
): ControlledCase {
  return {
    caseId,
    familyId: caseId,
    variantId: "good",
    targetCriterion: null,
    reference,
    criteria: Object.fromEntries(
      CONSOLIDATION_CRITERIA.map((key) => [key, { reference, scores }]),
    ) as ControlledCase["criteria"],
  };
}

test("selection prevents negative passes in every repeat, not only the median", () => {
  const cases = [
    item("positive", "pass", [0.95, 0.95, 0.95]),
    item("negative", "fail", [0.4, 0.4, 0.8]),
  ];
  const selected = selectControlledThresholds(cases);
  assert.equal(selected.thresholds.supported_by_evidence, 0.81);
  assert.equal(selected.assessment.overall.descriptiveAny.falsePositive, 0);
  assert.equal(selected.feasible, false, "small coverage cannot qualify");
});

test("uncertain labels do not force thresholds; impossible separation stays infeasible", () => {
  const selected = selectControlledThresholds([
    item("good", "pass", [0.99, 0.99, 0.99]),
    item("bad", "fail", [0.5, 0.5, 0.5]),
    item("uncertain", "uncertain", [1, 1, 1]),
  ]);
  assert.equal(selected.thresholds.meaningful_improvement, 0.51);
  const impossible = selectControlledThresholds([
    item("good", "pass", [1, 1, 1]),
    item("bad", "fail", [1, 1, 1]),
  ]);
  assert.equal(impossible.perCriterion.meaningful_improvement.exists, false);
  assert.equal(impossible.feasible, false);
});

test("AUC handles ties, absent coverage and score inversions", () => {
  assert.equal(auc([0.7], [0.7]), 0.5);
  assert.equal(auc([0.2], [0.8]), 0);
  assert.equal(auc([0.8], [0.2]), 1);
  assert.equal(auc([], [0.2]), null);
});

test("controlled pairs are only scored when the blind labels support their design", () => {
  const good = item("good", "pass", [0.9, 0.9, 0.9]);
  const bad = item("bad", "pass", [0.8, 0.8, 0.8]);
  bad.familyId = good.familyId;
  bad.variantId = "unsupported";
  bad.targetCriterion = "supported_by_evidence";
  const result = assessControlled([good, bad], {
    supported_by_evidence: 0.85,
    preserves_distinct_information: 0.85,
    no_new_human_action: 0.85,
    meaningful_improvement: 0.85,
  });
  assert.equal(
    result.criteria.supported_by_evidence.pairSeparation.eligible,
    0,
  );
  assert.equal(
    result.criteria.supported_by_evidence.pairSeparation.excluded,
    1,
  );
});

test("an overall fail takes precedence over uncertainty and inconsistent labels are rejected", () => {
  const mixed = item("mixed", "uncertain", [0.5, 0.5, 0.5]);
  mixed.criteria.meaningful_improvement.reference = "fail";
  assert.throws(() => selectControlledThresholds([mixed]), /Overall reference/);
  mixed.reference = "fail";
  assert.doesNotThrow(() => selectControlledThresholds([mixed]));
});
