import { batchQuestions } from "../maintenance/consolidator/batching";
import { evaluateJev } from "../maintenance/consolidator/jev";
import type {
  Answer,
  EvaluationRequest,
  Json,
  Question,
} from "../maintenance/consolidator/types";
import type { GatewayCall } from "../maintenance/gateway";

export const CANDIDATE_EVALUATION_CONCURRENCY = 3;
export interface CandidateQuestion {
  id: string;
  evidence: Json;
  question: Question;
}

/** Pack evidence with its questions, bounded by both shared context and question policy.
 * All requests use the original evaluator/parser, including its sequential capacity splits.
 */
export async function evaluateCandidatePool(
  task: { title: string; description: string },
  collection: "pages" | "projects",
  units: CandidateQuestion[],
  send: GatewayCall,
): Promise<Record<string, Answer>> {
  const request = (items: CandidateQuestion[]): EvaluationRequest => ({
    state: {
      task,
      [collection]: Object.fromEntries(
        items.map((item) => [item.id, item.evidence]),
      ),
    },
    questions: Object.fromEntries(
      items.map((item) => [item.id, item.question]),
    ),
  });
  const fits = (items: CandidateQuestion[]) => {
    const r = request(items);
    const plan = batchQuestions(r.state, r.questions);
    return plan.oversized.length === 0 && plan.batches.length === 1;
  };
  const batches: EvaluationRequest[] = [];
  let current: CandidateQuestion[] = [];
  for (const unit of units) {
    if (!fits([...current, unit])) {
      if (current.length) batches.push(request(current));
      current = [];
      if (!fits([unit]))
        throw new Error("Candidate evidence exceeds evaluation context.");
    }
    current.push(unit);
  }
  if (current.length) batches.push(request(current));
  const answers: Record<string, Answer> = {};
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < batches.length) {
      const batch = batches[next++];
      try {
        Object.assign(answers, (await evaluateJev(batch, send)).answers);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  // Drain in-flight requests before returning a fallback; no background evaluations.
  const settled = await Promise.allSettled(
    Array.from(
      { length: Math.min(CANDIDATE_EVALUATION_CONCURRENCY, batches.length) },
      worker,
    ),
  );
  const failure = settled.find((item) => item.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return answers;
}
