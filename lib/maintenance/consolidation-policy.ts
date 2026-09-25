import {
  type ConsolidationEvaluation,
  JEV_CONSOLIDATION_THRESHOLDS,
} from "./jev";

export type PositiveConsolidationEvaluation = ConsolidationEvaluation & {
  allowed: boolean;
  reasons: string[];
};

/** Applies only to positive questions, where true means the criterion passes. */
export function applyPositiveConsolidationPolicy(
  evaluation: ConsolidationEvaluation,
): PositiveConsolidationEvaluation {
  const reasons = Object.entries(JEV_CONSOLIDATION_THRESHOLDS)
    .filter(
      ([criterion, threshold]) => evaluation.answers[criterion] < threshold,
    )
    .map(
      ([criterion, threshold]) =>
        `${criterion}: ${evaluation.answers[criterion]} < ${threshold}`,
    );
  return { ...evaluation, allowed: reasons.length === 0, reasons };
}
