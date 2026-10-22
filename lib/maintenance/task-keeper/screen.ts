import { batchQuestions } from "../consolidator/batching";
import { validateEvaluation } from "../consolidator/jev";
import type { Answer, Evaluate, Json, Question } from "../consolidator/types";
import { TASK_KEEPER_THRESHOLDS } from "./policy";
import { keeperQuestion } from "./prompts";
import { type KeeperSnapshot, snapshotMarkdown } from "./snapshot";

// Step 2 of the pipeline: one Jev screening request per page, then passage
// localization, only after a positive whole-page signal (as the consolidator).

export type ScreenResult =
  | { status: "negative"; probability: number }
  | { status: "oversized" }
  | { status: "no_passages"; probability: number }
  | { status: "candidates"; probability: number; candidates: number[] };

/** Oversized evidence: the request would exceed Jev's policy limits. */
class Oversized extends Error {}

export async function askAll(
  state: Json,
  questions: Record<string, Question>,
  evaluate: Evaluate,
): Promise<Record<string, Answer>> {
  const { batches, oversized } = batchQuestions(state, questions);
  if (oversized.length) throw new Oversized();
  const answers: Record<string, Answer> = {};
  for (const batch of batches) {
    const request = { state, questions: batch };
    const evaluation = validateEvaluation(request, await evaluate(request));
    Object.assign(answers, evaluation.answers);
  }
  return answers;
}

export function probability(answer: Answer | undefined): number {
  return answer?.type === "boolean" ? answer.probability : 0;
}

function pageMetadata(snapshot: KeeperSnapshot) {
  const { id, slug, title, type, summary, tags, aliases } = snapshot.page;
  return { id, slug, title, type, summary, tags, aliases };
}

export async function screenPage(
  snapshot: KeeperSnapshot,
  evaluate: Evaluate,
): Promise<ScreenResult> {
  const units = snapshot.units
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => unit.text.trim());
  if (!units.length) return { status: "negative", probability: 0 };
  try {
    const screening = await askAll(
      {
        pages: [
          { ...pageMetadata(snapshot), markdown: snapshotMarkdown(snapshot) },
        ],
      },
      { screening: keeperQuestion("screening") },
      evaluate,
    );
    const screened = probability(screening.screening);
    if (screened < TASK_KEEPER_THRESHOLDS.screening)
      return { status: "negative", probability: screened };
    const localization = await askAll(
      {
        pages: [pageMetadata(snapshot)],
        units: units.map(({ unit }) => ({
          id: unit.id,
          start: unit.start,
          end: unit.end,
          text: unit.text,
          headings: unit.headings,
        })),
      },
      Object.fromEntries(
        units.map((_, position) => [
          `passage_${position}`,
          keeperQuestion("localize", { index: String(position) }),
        ]),
      ),
      evaluate,
    );
    const candidates = units
      .filter(
        (_, position) =>
          probability(localization[`passage_${position}`]) >=
          TASK_KEEPER_THRESHOLDS.localization,
      )
      .map(({ index }) => index);
    return candidates.length
      ? { status: "candidates", probability: screened, candidates }
      : { status: "no_passages", probability: screened };
  } catch (error) {
    if (error instanceof Oversized) return { status: "oversized" };
    throw error;
  }
}
