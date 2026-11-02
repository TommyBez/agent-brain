import { batchQuestions } from "../maintenance/consolidator/batching";
import { evaluateJev } from "../maintenance/consolidator/jev";
import type {
  Answer,
  EvaluationRequest,
  Json,
  Question,
} from "../maintenance/consolidator/types";
import { POLICY } from "../maintenance/consolidator/types";
import { type GatewayCall, GatewayRequestError } from "../maintenance/gateway";
import {
  abortableSuggestionSend,
  SUGGESTION_POLICY,
  type SuggestionOptions,
} from "./suggestion-control";

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
  options: SuggestionOptions = {},
): Promise<Record<string, Answer>> {
  const signal =
    options.signal ?? AbortSignal.timeout(SUGGESTION_POLICY.deadlineMs);
  const boundedSend = abortableSuggestionSend(send, signal);
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
  const batches: CandidateQuestion[][] = [];
  let current: CandidateQuestion[] = [];
  for (const original of units) {
    const unit = {
      ...original,
      evidence: truncateCandidateEvidence(original.evidence),
    };
    if (!fits([...current, unit])) {
      if (current.length) batches.push(current);
      current = [];
      if (!fits([unit])) continue;
    }
    current.push(unit);
  }
  if (current.length) batches.push(current);
  const answers: Record<string, Answer> = {};
  let next = 0;
  let failed = false;
  const run = async (
    items: CandidateQuestion[],
  ): Promise<Record<string, Answer>> => {
    signal.throwIfAborted();
    try {
      return (
        await evaluateJev(request(items), boundedSend, async () => {
          // Disable question-only splitting here; the outer split rebuilds state too.
          throw new GatewayRequestError("Repartition candidate evidence", {
            reason: "max_tokens_exceeded",
            retryable: false,
          });
        })
      ).answers;
    } catch (error) {
      if (
        !(error instanceof GatewayRequestError) ||
        error.reason !== "max_tokens_exceeded"
      )
        throw error;
      if (items.length === 1) return {};
      const mid = Math.ceil(items.length / 2);
      return {
        ...(await run(items.slice(0, mid))),
        ...(await run(items.slice(mid))),
      };
    }
  };
  const worker = async () => {
    while (!failed && next < batches.length) {
      const batch = batches[next++];
      try {
        Object.assign(answers, await run(batch));
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

/** A head excerpt, not a model summary: total title + slug + markdown <= snapshot unit cap. */
export function truncateCandidateEvidence(evidence: Json): Json {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence))
    return evidence;
  let remaining: number = POLICY.maxUnitCharacters;
  const head = (value: Json | undefined) => {
    const text = typeof value === "string" ? value.slice(0, remaining) : "";
    remaining -= text.length;
    return text;
  };
  return {
    title: head(evidence.title),
    slug: head(evidence.slug),
    markdown: head(evidence.markdown),
  };
}
