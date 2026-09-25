import type { Answer } from "./types";

/** Decision thresholds are independent from the model's exact input and answer. */
export type DecisionPolicy = {
  id: string;
  analyst: {
    yes: number;
    no: number;
    choiceProbability: number;
    choiceConfidence: number | null;
  };
  verifier: {
    objective: number;
    integrity: number;
    link: number;
    conduct: number;
    reject: number;
  };
};

export const SEED_DECISION_POLICY: DecisionPolicy = {
  id: "nightly-consolidation-seed-4",
  analyst: { yes: 0.9, no: 0.1, choiceProbability: 0.9, choiceConfidence: 0.9 },
  verifier: {
    objective: 0.9,
    integrity: 0.9,
    link: 0.9,
    conduct: 0.9,
    reject: 0.1,
  },
};

// Fitted on calibration only; frozen before holdout was opened.
// Evidence: docs/consolidator-calibration-profile-2026-09-25.json.
export const DEFAULT_DECISION_POLICY: DecisionPolicy = {
  id: "consolidator-calibrated-4541df1d389a34d0",
  analyst: {
    yes: 0.8,
    no: 0.2,
    choiceProbability: 0.8,
    choiceConfidence: null,
  },
  verifier: {
    objective: 0.8,
    integrity: 0.65,
    link: 0.9,
    conduct: 0.8,
    reject: 0.1,
  },
};

/** Discovery coverage is never tuned together with the final authorization gates. */
export const DISCOVERY_FLOOR = 0.1;

export function analystGates(policy: DecisionPolicy) {
  return {
    yes: (answer: Answer | undefined) =>
      answer?.type === "boolean" && answer.probability >= policy.analyst.yes,
    no: (answer: Answer | undefined) =>
      answer?.type === "boolean" && answer.probability <= policy.analyst.no,
    certainChoice: (answer: Answer | undefined): string | undefined =>
      answer?.type === "choice" &&
      answer.probabilities[answer.choice] >= policy.analyst.choiceProbability &&
      (policy.analyst.choiceConfidence === null ||
        answer.confidence === null ||
        answer.confidence >= policy.analyst.choiceConfidence)
        ? answer.choice
        : undefined,
  };
}

export type VerificationFamily = "objective" | "integrity" | "link" | "conduct";

/** Unrecognized future criteria remain in the preservation/support family. */
export function verificationFamily(questionId: string): VerificationFamily {
  if (questionId === "objective") return "objective";
  if (questionId === "no_human_work" || questionId === "no_diary")
    return "conduct";
  if (questionId.startsWith("link_")) return "link";
  return "integrity";
}

export function verificationThreshold(
  questionId: string,
  policy: DecisionPolicy,
): number {
  return policy.verifier[verificationFamily(questionId)];
}

function exactFields(value: unknown, fields: string[]): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function probability(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

export function validateDecisionPolicy(policy: DecisionPolicy): DecisionPolicy {
  if (
    !exactFields(policy, ["id", "analyst", "verifier"]) ||
    !exactFields(policy.analyst, [
      "yes",
      "no",
      "choiceProbability",
      "choiceConfidence",
    ]) ||
    !exactFields(policy.verifier, [
      "objective",
      "integrity",
      "link",
      "conduct",
      "reject",
    ])
  )
    throw new Error("Invalid decision policy fields");
  if (typeof policy.id !== "string" || !policy.id.trim())
    throw new Error("Invalid policy identity");
  for (const value of [
    policy.analyst.yes,
    policy.analyst.no,
    policy.analyst.choiceProbability,
    policy.verifier.objective,
    policy.verifier.integrity,
    policy.verifier.link,
    policy.verifier.conduct,
    policy.verifier.reject,
  ]) {
    if (!probability(value)) throw new Error("Invalid decision threshold");
  }
  if (
    policy.analyst.choiceConfidence !== null &&
    !probability(policy.analyst.choiceConfidence)
  )
    throw new Error("Invalid decision threshold");
  if (
    policy.analyst.no >= policy.analyst.yes ||
    [
      policy.verifier.objective,
      policy.verifier.integrity,
      policy.verifier.link,
      policy.verifier.conduct,
    ].some((threshold) => threshold <= policy.verifier.reject)
  )
    throw new Error("Overlapping decision bands");
  return policy;
}
