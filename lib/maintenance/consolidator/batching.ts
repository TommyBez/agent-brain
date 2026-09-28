import { type Json, POLICY, type Question } from "./types";

/** Size the shared state once; JSON entries contribute only their key, value and comma. */
export function batchQuestions(
  state: Json,
  questions: Record<string, Question>,
): { batches: Record<string, Question>[]; oversized: string[] } {
  const baseSize = JSON.stringify({ state, questions: {} }).length;
  const batches: Record<string, Question>[] = [];
  const oversized: string[] = [];
  let current: Record<string, Question> = {};
  let count = 0;
  let size = baseSize;
  for (const [id, question] of Object.entries(questions)) {
    const entrySize = JSON.stringify({ [id]: question }).length - 2;
    if (baseSize + entrySize > POLICY.evaluationCharacters) {
      oversized.push(id);
      continue;
    }
    if (
      count &&
      (count === POLICY.questionsPerRequest ||
        size + 1 + entrySize > POLICY.evaluationCharacters)
    ) {
      batches.push(current);
      current = {};
      count = 0;
      size = baseSize;
    }
    size += entrySize + (count ? 1 : 0);
    current[id] = question;
    count++;
  }
  if (count) batches.push(current);
  return { batches, oversized };
}
