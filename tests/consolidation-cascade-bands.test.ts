import assert from "node:assert/strict";
import test from "node:test";
import { CONSOLIDATION_CRITERIA } from "../lib/maintenance/consolidation-rubric";
import {
  type DevelopmentCase,
  deriveCascadeBands,
} from "../scripts/prepare-consolidation-cascade";

function item(
  id: string,
  reference: "pass" | "fail" | "uncertain",
  scores: number[],
): DevelopmentCase {
  return {
    caseId: id,
    inputHash: "x",
    source: "test",
    criteria: Object.fromEntries(
      CONSOLIDATION_CRITERIA.map((k) => [k, { reference, scores }]),
    ) as DevelopmentCase["criteria"],
  };
}
test("overlapping scores remain gray instead of making confidently wrong decisions", () => {
  const r = deriveCascadeBands([
    item("p", "pass", [0.6, 0.59, 0.61]),
    item("n", "fail", [0.87, 0.86, 0.88]),
  ]).criteria.meaningful_improvement;
  assert.equal(r.rejectBelow, 0.54);
  assert.equal(r.acceptAtOrAbove, 0.93);
});
test("separated classes retain an intermediate interval with margin on both extremes", () => {
  const r = deriveCascadeBands([
    item("p", "pass", [0.91, 0.92, 0.93]),
    item("n", "fail", [0.05, 0.06, 0.07]),
  ]).criteria.no_new_human_action;
  assert.equal(r.rejectBelow, 0.12);
  assert.equal(r.acceptAtOrAbove, 0.86);
});
test("uncertain labels are protected from both automatic decisions", () => {
  const r = deriveCascadeBands([
    item("p", "pass", [0.9, 0.9, 0.9]),
    item("n", "fail", [0.1, 0.1, 0.1]),
    item("u", "uncertain", [0.3, 0.5, 0.8]),
  ]).criteria.supported_by_evidence;
  assert.equal(r.rejectBelow, 0.25);
  assert.equal(r.acceptAtOrAbove, 0.85);
});
test("missing coverage disables auto-decisions and rejects malformed repetitions", () => {
  const r = deriveCascadeBands([item("p", "pass", [0.9, 0.9, 0.9])]).criteria
    .supported_by_evidence;
  assert.equal(r.rejectBelow, 0);
  assert.equal(r.acceptAtOrAbove, 1.01);
  assert.throws(
    () => deriveCascadeBands([item("bad", "fail", [0.8])]),
    /Invalid/,
  );
});
