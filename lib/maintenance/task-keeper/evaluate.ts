import { batchQuestions } from "../consolidator/batching";
import { validateEvaluation } from "../consolidator/jev";
import type { Answer, Evaluate, Json, Question } from "../consolidator/types";

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
