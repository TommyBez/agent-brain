import type { Answer } from "./types";

export const DECISION_POLICY = {
  id: "consolidator-calibrated-4541df1d389a34d0",
  analyst: {
    yes: 0.8,
    no: 0.2,
    choiceProbability: 0.8,
  },
  verifier: {
    objective: 0.8,
    integrity: 0.65,
    link: 0.9,
    conduct: 0.8,
    reject: 0.1,
  },
} as const;

/** Evidence discovery includes candidates below the authorization thresholds. */
export const DISCOVERY_FLOOR = 0.1;

export const analystGates = {
  yes: (answer: Answer | undefined) =>
    answer?.type === "boolean" &&
    answer.probability >= DECISION_POLICY.analyst.yes,
  no: (answer: Answer | undefined) =>
    answer?.type === "boolean" &&
    answer.probability <= DECISION_POLICY.analyst.no,
  certainChoice: (answer: Answer | undefined): string | undefined =>
    answer?.type === "choice" &&
    answer.probabilities[answer.choice] >=
      DECISION_POLICY.analyst.choiceProbability
      ? answer.choice
      : undefined,
};

export function verificationThreshold(questionId: string): number {
  const { verifier } = DECISION_POLICY;
  if (questionId === "objective") return verifier.objective;
  if (questionId === "no_human_work" || questionId === "no_diary")
    return verifier.conduct;
  if (questionId.startsWith("link_")) return verifier.link;
  return verifier.integrity;
}
