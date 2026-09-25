import {
  type ConsolidationCriterion as Criterion,
  CONSOLIDATION_CRITERIA as criteria,
} from "./consolidation-rubric";

export const defectArms = ["positive", "negative", "defect"] as const;
export type DefectArm = (typeof defectArms)[number];
export type Reference = "pass" | "fail" | "uncertain";
export type Decision = "allow" | "reject" | "defer" | "error";
export type ByCriterion<T> = Record<Criterion, T>;
export type Receipt = {
  repeat: number;
  outcome: "success" | "failed";
  rawScores?: ByCriterion<number>;
  risks?: ByCriterion<number>;
};
export type DefectAnalysisCase = {
  caseId: string;
  familyId: string;
  source?: string;
  split: "calibration" | "validation";
  referenceCriteria: ByCriterion<{ verdict: Reference; rationale: string }>;
  receipts: Record<DefectArm, Receipt[]>;
};
export type Observation = {
  caseId: string;
  familyId: string;
  source?: string;
  repeat: number;
  reference: Reference;
  risk: number | null;
};
export type DefectBand = { allowBelow: number; rejectAtOrAbove: number };
export const grid = Array.from({ length: 102 }, (_, index) => index / 100);
export const refs: Reference[] = ["pass", "fail", "uncertain"];
export const directions: Decision[] = ["allow", "reject", "defer", "error"];
export const names: Record<Criterion, string> = {
  supported_by_evidence: "Fonti",
  preserves_distinct_information: "Conservazione",
  no_new_human_action: "Azioni umane",
  meaningful_improvement: "Utilità",
};
export const armNames: Record<DefectArm, string> = {
  positive: "Domanda positiva",
  negative: "Inversione letterale",
  defect: "Ricerca di difetti",
};

export const SELECTION_METHOD = {
  version: 1,
  risk: "positive: 1 - rawScore; negative and defect: rawScore. Normalized risk rounded to 12 decimal places before comparison to avoid binary complement artifacts.",
  grid: { minimum: 0, maximum: 1.01, step: 0.01 },
  repetitions: 3,
  single: {
    decision: "reject iff risk >= threshold; otherwise allow",
    defectFirst:
      "Highest grid threshold with zero reference-fail observations allowed in any repetition; reference-uncertain excluded.",
    lowFalseAlarms:
      "Lowest grid threshold with zero reference-pass observations rejected in any repetition; reference-uncertain excluded.",
    missingCoverage: "Either pass or fail absent: both thresholds null.",
  },
  dual: {
    decision:
      "allow iff risk < allowBelow; reject iff risk >= rejectAtOrAbove; otherwise defer. allowBelow <= rejectAtOrAbove.",
    constraints:
      "Zero reference-fail auto-allow and zero reference-pass auto-reject in every repetition. Every reference-uncertain observation must defer.",
    objective:
      "Maximize total automatic observation decisions across three repetitions (equivalent to maximum mean automatic decisions).",
    ties: "Prefer wider review band, then lower allowBelow, then higher rejectAtOrAbove. Compare integer grid indices.",
    missingCoverage:
      "Either pass or fail absent: allowBelow=0, rejectAtOrAbove=1.01 (all defer).",
  },
  errors:
    "Selection requires all three successful receipts per case and arm. Later errors remain separate from factual rejection or uncertainty.",
  evaluation:
    "Freeze all three arms and four criteria on calibration only. Never retune on validation. Repeated scores are correlated measurements, not independent cases. Scores are not assumed calibrated probabilities.",
  sensitivity:
    "All single thresholds; all ordered dual grid bands for calibration Pareto frontier. At frozen bands, move one boundary by -0.10,-0.05,-0.01,+0.01,+0.05,+0.10, clipped to grid and the other boundary. Apply unchanged to validation. Proposal simulation rejects if any criterion rejects, allows only if all allow, otherwise defers; any technical error takes precedence.",
};

export function mapCriteria<T>(
  fn: (criterion: Criterion) => T,
): ByCriterion<T> {
  return Object.fromEntries(
    criteria.map((key) => [key, fn(key)]),
  ) as ByCriterion<T>;
}
export function mapArms<T>(fn: (arm: DefectArm) => T): Record<DefectArm, T> {
  return Object.fromEntries(defectArms.map((arm) => [arm, fn(arm)])) as Record<
    DefectArm,
    T
  >;
}
function validRisk(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}
export function receiptRisk(
  receipt: Receipt | undefined,
  arm: DefectArm,
  criterion: Criterion,
) {
  if (!receipt || receipt.outcome !== "success") return null;
  const raw = receipt.rawScores?.[criterion];
  const risk = receipt.risks?.[criterion];
  if (!validRisk(raw) || !validRisk(risk))
    throw new Error("Malformed successful score receipt.");
  const normalized = Number((arm === "positive" ? 1 - raw : raw).toFixed(12));
  if (normalized !== risk) throw new Error("Incorrect risk normalization.");
  return normalized;
}
export function observations(
  rows: DefectAnalysisCase[],
  arm: DefectArm,
  criterion: Criterion,
): Observation[] {
  return rows.flatMap((row) => {
    const receipts = row.receipts[arm];
    if (
      new Set(receipts.map((item) => item.repeat)).size !== receipts.length ||
      receipts.some((item) => ![1, 2, 3].includes(item.repeat))
    )
      throw new Error("Duplicate or invalid repetition.");
    const reference = row.referenceCriteria[criterion].verdict;
    if (!refs.includes(reference))
      throw new Error("Invalid reference verdict.");
    return [1, 2, 3].map((repeat) => ({
      caseId: row.caseId,
      familyId: row.familyId,
      source: row.source,
      repeat,
      reference,
      risk: receiptRisk(
        receipts.find((item) => item.repeat === repeat),
        arm,
        criterion,
      ),
    }));
  });
}

export function decideDefectRisk(
  risk: number | null,
  band: DefectBand,
): Decision {
  if (risk === null) return "error";
  if (risk < band.allowBelow) return "allow";
  if (risk >= band.rejectAtOrAbove) return "reject";
  return "defer";
}
export function singleDecision(
  risk: number | null,
  threshold: number,
): Decision {
  return risk === null ? "error" : risk >= threshold ? "reject" : "allow";
}
type Matrix = Record<Reference, Record<Decision, number>>;
export function measure(
  items: Observation[],
  decide: (risk: number | null) => Decision,
) {
  const matrix = Object.fromEntries(
    refs.map((ref) => [
      ref,
      Object.fromEntries(directions.map((decision) => [decision, 0])),
    ]),
  ) as Matrix;
  for (const item of items) matrix[item.reference][decide(item.risk)]++;
  const count = (decision: Decision) =>
    refs.reduce((sum, ref) => sum + matrix[ref][decision], 0);
  return {
    observations: items.length,
    uniqueCases: new Set(items.map((item) => item.caseId)).size,
    matrix,
    allowed: count("allow"),
    rejected: count("reject"),
    deferred: count("defer"),
    errors: count("error"),
    automatic: count("allow") + count("reject"),
    defectsMissed: matrix.fail.allow,
    goodBlocked: matrix.pass.reject,
    uncertainDecided: matrix.uncertain.allow + matrix.uncertain.reject,
  };
}
function coverage(items: Observation[]) {
  return Object.fromEntries(
    refs.map((reference) => [
      reference,
      new Set(
        items
          .filter((item) => item.reference === reference)
          .map((item) => item.caseId),
      ).size,
    ]),
  ) as Record<Reference, number>;
}

export function selectCriterionThresholds(items: Observation[]) {
  if (items.some((item) => item.risk === null))
    throw new Error(
      "Cannot select thresholds with incomplete calibration scores.",
    );
  const counts = coverage(items);
  const missingCoverage = !counts.pass || !counts.fail;
  if (missingCoverage)
    return {
      dual: { allowBelow: 0, rejectAtOrAbove: 1.01 },
      single: { defectFirst: null, lowFalseAlarms: null },
      coverage: counts,
      missingCoverage: true,
      calibration: measure(items, () => "defer"),
    };
  const certain = items.filter((item) => item.reference !== "uncertain");
  const single = grid.map((threshold) => ({
    threshold,
    result: measure(certain, (risk) => singleDecision(risk, threshold)),
  }));
  const defectFirst = single
    .filter((entry) => !entry.result.defectsMissed)
    .at(-1)?.threshold;
  const lowFalseAlarms = single.find(
    (entry) => !entry.result.goodBlocked,
  )?.threshold;
  if (defectFirst === undefined || lowFalseAlarms === undefined)
    throw new Error("Grid lacks sentinel thresholds.");
  let best = { allowBelow: 0, rejectAtOrAbove: 1.01 };
  let bestAutomatic = -1;
  let bestWidth = -1;
  for (let li = 0; li < grid.length; li++) {
    const lower = grid[li];
    const low = items.filter((item) => (item.risk as number) < lower);
    if (low.some((item) => item.reference !== "pass")) continue;
    for (let ui = li; ui < grid.length; ui++) {
      const upper = grid[ui];
      const high = items.filter((item) => (item.risk as number) >= upper);
      if (high.some((item) => item.reference !== "fail")) continue;
      const automatic = low.length + high.length;
      const width = ui - li;
      if (
        automatic > bestAutomatic ||
        (automatic === bestAutomatic &&
          (width > bestWidth ||
            (width === bestWidth && lower < best.allowBelow)))
      ) {
        best = { allowBelow: lower, rejectAtOrAbove: upper };
        bestAutomatic = automatic;
        bestWidth = width;
      }
    }
  }
  return {
    dual: best,
    single: { defectFirst, lowFalseAlarms },
    coverage: counts,
    missingCoverage: false,
    calibration: measure(items, (risk) => decideDefectRisk(risk, best)),
  };
}

/** This function must never receive or select on holdout rows. */
export function selectThresholds(rows: DefectAnalysisCase[]) {
  if (!rows.length || rows.some((row) => row.split !== "calibration"))
    throw new Error("Threshold selection requires calibration rows only.");
  if (
    rows.some((row) => defectArms.some((arm) => row.receipts[arm].length !== 3))
  )
    throw new Error(
      "Threshold selection requires exactly three receipts per case and arm.",
    );
  if (new Set(rows.map((row) => row.caseId)).size !== rows.length)
    throw new Error("Duplicate calibration cases.");
  return mapArms((arm) =>
    mapCriteria((criterion) =>
      selectCriterionThresholds(observations(rows, arm, criterion)),
    ),
  );
}
