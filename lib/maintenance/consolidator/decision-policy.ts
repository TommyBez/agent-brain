import type { Answer } from "./types";

export const DECISION_POLICY = {
  id: "page-consolidator-v3",
  analyst: {
    yes: 0.8,
    choiceProbability: 0.8,
  },
  verifier: {
    objective: 0.8,
    integrity: 0.65,
    conduct: 0.8,
    reject: 0.1,
  },
} as const;

/** Screening routes work; it never authorizes a mutation. */
export const SCREENING_THRESHOLD = 0.8;

export const analystGates = {
  yes: (answer: Answer | undefined) =>
    answer?.type === "boolean" &&
    answer.probability >= DECISION_POLICY.analyst.yes,
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
  return verifier.integrity;
}
