import { fingerprint } from "../../canonical-json";
import type { Evaluate } from "../consolidator/types";
import { TASK_KEEPER_LIMITS, TASK_KEEPER_THRESHOLDS } from "./policy";
import { keeperQuestion } from "./prompts";
import { askAll, probability } from "./screen";
import type { Excerpt } from "./snapshot";
import type { VerifiedItem } from "./verify";

// Step 5: an extraction is identified by its source page, passages and title.
// Rejections are remembered by that fingerprint, and each cited passage keeps
// a title-free identity, so a reworded title of a rejected (even purged)
// extraction stays rejected. Anything else that means the same work as an
// existing task (open or closed) becomes a `new_source` suggestion on that
// task instead of a new task.

/** Case, accents' composition, punctuation and spacing do not change identity. */
export function normalizeForFingerprint(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("it")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable across page versions and keeper policies, so rejections never return. */
export function extractionFingerprint(
  pageId: string,
  passageTexts: string[],
  title: string,
): string {
  return fingerprint({
    kind: "task-keeper-extraction",
    page: pageId,
    passages: passageTexts.map(normalizeForFingerprint),
    title: normalizeForFingerprint(title),
  });
}

/** One cited passage of a page, without the model-written title. */
export function passageIdentity(pageId: string, passageText: string): string {
  return fingerprint({
    kind: "task-keeper-extraction-passage",
    page: pageId,
    passage: normalizeForFingerprint(passageText),
  });
}

export interface DuplicateCandidate {
  id: string;
  number: number;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  status: string;
  /** Its extraction fingerprint was rejected (or the task purged). */
  rejected: boolean;
  /** It already cites this source page with an active source link. */
  sameSource: boolean;
}

export type DuplicateDecision =
  | { outcome: "none" }
  | {
      outcome: "rejected" | "existing" | "new_source";
      candidate: DuplicateCandidate;
      probability: number;
    };

export async function judgeDuplicate(
  item: VerifiedItem,
  excerpt: Excerpt,
  candidates: DuplicateCandidate[],
  evaluate: Evaluate,
): Promise<DuplicateDecision> {
  const shortlist = candidates.slice(0, TASK_KEEPER_LIMITS.candidatesPerItem);
  if (!shortlist.length) return { outcome: "none" };
  const answers = await askAll(
    {
      new: {
        title: item.title,
        excerpt: excerpt.text.slice(0, 2000),
        actorNames: item.actorNames,
        dueText: item.dueText,
      },
      existing: Object.fromEntries(
        shortlist.map((candidate, index) => [
          `c${index}`,
          {
            title: candidate.title,
            description: candidate.description.slice(0, 1500),
            acceptanceCriteria: candidate.acceptanceCriteria.slice(0, 10),
            status: candidate.status,
          },
        ]),
      ),
    },
    Object.fromEntries(
      shortlist.map((_, index) => [
        `duplicate_c${index}`,
        keeperQuestion("duplicate", { key: `c${index}` }),
      ]),
    ),
    evaluate,
  );
  let best: { candidate: DuplicateCandidate; probability: number } | null =
    null;
  for (const [index, candidate] of shortlist.entries()) {
    const value = probability(answers[`duplicate_c${index}`]);
    if (
      value >= TASK_KEEPER_THRESHOLDS.duplicate &&
      (!best || value > best.probability)
    )
      best = { candidate, probability: value };
  }
  return best ? decideDuplicate(best, excerpt.text) : { outcome: "none" };
}

/**
 * A rejected match stays rejected. A match that already cites this page with
 * the same passage (quoted in its description) is not new; a changed passage
 * of the same page (e.g. a moved deadline) is a new source.
 */
export function decideDuplicate(
  match: { candidate: DuplicateCandidate; probability: number },
  excerptText: string,
): DuplicateDecision {
  const samePassage =
    match.candidate.sameSource &&
    normalizeForFingerprint(match.candidate.description).includes(
      normalizeForFingerprint(excerptText),
    );
  const outcome = match.candidate.rejected
    ? "rejected"
    : samePassage
      ? "existing"
      : "new_source";
  return { outcome, ...match };
}
