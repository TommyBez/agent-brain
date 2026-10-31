import type { CapacityLimit, Verification } from "./types";

/** Bump when the evaluator, input limits or lossless encoding changes. */
export const CAPACITY_POLICY_VERSION = "jev-1.14-lossless-v2";

/** A deterministic input-size limit, not a retryable provider failure. */
export class CapacityError extends Error {
  readonly capacity: CapacityLimit;

  constructor(
    stage: CapacityLimit["stage"],
    requiredCharacters: number,
    limitCharacters: number,
  ) {
    super(
      `Consolidation ${stage} requires ${requiredCharacters} characters; capacity is ${limitCharacters}.`,
    );
    this.name = "CapacityError";
    this.capacity = { stage, requiredCharacters, limitCharacters };
  }
}

export function capacityVerification(capacity: CapacityLimit): Verification {
  return {
    status: "uncertain",
    incomplete: true,
    capacity,
    defects: [
      `Complete ${capacity.stage} context exceeds capacity (${capacity.requiredCharacters}/${capacity.limitCharacters} characters); no content or coverage was truncated.`,
    ],
    judgments: [],
  };
}
