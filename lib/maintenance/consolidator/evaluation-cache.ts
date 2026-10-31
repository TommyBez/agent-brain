import { BrainError } from "../../brain/types";
import { fingerprint } from "../../canonical-json";
import type { GatewayCall } from "../gateway";
import { BudgetExhaustedError } from "./budget";
import { failureDiagnostic } from "./diagnostics";
import { evaluateJev, JEV_MODEL } from "./jev";
import { recordKeys } from "./keys";
import {
  findConsolidationRecord,
  readConsolidationRecord,
  saveConsolidationRecord,
} from "./store";
import type { Evaluation, EvaluationRequest } from "./types";

/** One owner-wide `evaluation:` cache for pages and the nightly task phases. */
export function evaluationCacheKey(request: EvaluationRequest) {
  return recordKeys.evaluation(fingerprint({ model: JEV_MODEL, request }));
}

export type EvaluationCacheOptions = {
  /** Log event for failures, e.g. `task_links.evaluation_error`. */
  logEvent?: string;
};

/** Reuse a stored Jev answer, or pay through `gateway` and store it under `runId`.
 * The gateway decides which spending purpose a provider call is charged to.
 */
export async function evaluatePersisted(
  ownerId: string,
  runId: string,
  request: EvaluationRequest,
  gateway: GatewayCall,
  options: EvaluationCacheOptions = {},
): Promise<Evaluation> {
  const key = evaluationCacheKey(request);
  let stage = "evaluation_cache";
  try {
    const previous = await findConsolidationRecord<Evaluation>(ownerId, key);
    if (previous) return previous;
    stage = "evaluation_provider";
    // Persist each successful split before evaluating the next one. A later
    // failure must not discard completed work or expose a partial aggregate.
    const evaluation = await evaluateJev(request, gateway, (part) =>
      evaluatePersisted(ownerId, runId, part, gateway, options),
    );
    stage = "evaluation_save";
    try {
      await saveConsolidationRecord(ownerId, runId, key, evaluation);
    } catch (error) {
      if (error instanceof BrainError && error.code === "RECORD_CONFLICT") {
        const committed = await readConsolidationRecord<Evaluation>(
          ownerId,
          runId,
          key,
        );
        if (committed) return committed;
      }
      throw error;
    }
    return evaluation;
  } catch (error) {
    if (error instanceof BudgetExhaustedError) throw error;
    console.error(options.logEvent ?? "consolidation.evaluation_error", {
      runId,
      requestKey: key,
      stage,
      ...failureDiagnostic(error),
    });
    throw error;
  }
}
