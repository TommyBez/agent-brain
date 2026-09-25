import type { ConsolidationCriterion } from "./consolidation-rubric";
import { GatewayRequestError } from "./gateway";
import type { ConsolidationEvaluationInput } from "./jev";
import {
  evaluateWithKimi,
  type KimiEvaluation,
  KimiResponseError,
  type KimiReviewReceipt,
  type KimiTechnicalCause,
  type KimiUsage,
} from "./kimi-evaluator";
import { KIMI_SOURCE_CHALLENGE_CONTRACT } from "./kimi-source-challenge";

export const KIMI_SOURCE_CONTRACT_ARMS = ["baseline", "clarified"] as const;
export type KimiSourceContractArm = (typeof KIMI_SOURCE_CONTRACT_ARMS)[number];

export const KIMI_SOURCE_CONTRACT = {
  version: "source-single-review-v1",
  physicalCalls: 1,
  sourceChallenge: KIMI_SOURCE_CHALLENGE_CONTRACT,
  decision:
    "One request for selected criteria only; derive support from validated associations; other criteria retain verdict/rationale; malformed evidence is an error, never a semantic fail.",
} as const;

/** Compatibility export for historical runners; one authoritative instruction text. */
export const KIMI_SOURCE_CONTRACT_CLARIFICATION =
  KIMI_SOURCE_CHALLENGE_CONTRACT.instructions;

type KimiOptions = NonNullable<Parameters<typeof evaluateWithKimi>[2]>;

function singleUsage(usage: KimiUsage): KimiUsage {
  return {
    ...usage,
    physicalCalls: 1,
    unknownCostCalls: usage.costUsd === null ? 1 : 0,
    unknownTokenCalls:
      usage.inputTokens === null || usage.outputTokens === null ? 1 : 0,
  };
}

const noUsage: KimiUsage = {
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  reasoningTokens: null,
  cachedInputTokens: null,
  costUsd: null,
};

/** One mixed review. Only selected support uses the association contract. */
export async function evaluateWithKimiSourceContract(
  input: ConsolidationEvaluationInput,
  criteria: ConsolidationCriterion[],
  arm: KimiSourceContractArm,
  options: KimiOptions = {},
): Promise<KimiEvaluation> {
  if (!KIMI_SOURCE_CONTRACT_ARMS.includes(arm)) {
    throw new GatewayRequestError("Kimi source contract arm is invalid.", {
      retryable: false,
    });
  }
  if (arm === "baseline") return evaluateWithKimi(input, criteria, options);

  const send = options.fetch ?? fetch;
  let requested = false;
  const started = performance.now();
  try {
    const result = await evaluateWithKimi(input, criteria, {
      ...options,
      sourceReview: "counterexample",
      auditSourceSupport: true,
      auditPreservation: true,
      fetch: async (url, init) => {
        requested = true;
        return send(url, init);
      },
    });
    const usage = singleUsage(result.usage);
    return {
      ...result,
      usage,
      reviewReceipts: [
        {
          review: "single",
          outcome: "success",
          ...(result.judgments.supported_by_evidence
            ? { judgment: result.judgments.supported_by_evidence }
            : {}),
          usage,
          responseId: result.responseId,
          responseModel: result.responseModel,
          latencyMs: result.latencyMs,
        },
      ],
    };
  } catch (error) {
    // Local invalid input is not a provider attempt and must not invent usage.
    if (!requested) throw error;
    const parsed = error instanceof KimiResponseError ? error : null;
    const gateway = error instanceof GatewayRequestError ? error : null;
    const technicalCause: KimiTechnicalCause = {
      kind: parsed
        ? "invalid_response"
        : gateway?.status != null
          ? "http"
          : gateway
            ? "transport_or_configuration"
            : "unexpected",
      status: gateway?.status ?? null,
      retryable: gateway?.retryable ?? false,
      retryAfterMs: gateway?.retryAfterMs ?? null,
    };
    const usage = singleUsage(parsed?.usage ?? noUsage);
    const failedReceipt: KimiReviewReceipt = {
      review: "single",
      outcome: "error",
      usage,
      responseId: parsed?.responseId ?? null,
      responseModel: parsed?.responseModel ?? null,
      latencyMs: parsed?.latencyMs ?? performance.now() - started,
      stage: parsed?.stage ?? "request",
      reasonCode: parsed?.reasonCode ?? "request_unavailable",
      technicalCause,
    };
    const failure = new KimiResponseError(
      failedReceipt.stage ?? "request",
      failedReceipt.reasonCode ?? "request_unavailable",
      { id: failedReceipt.responseId, model: failedReceipt.responseModel },
      failedReceipt.latencyMs,
      usage,
    );
    failure.reviewReceipts = [failedReceipt];
    failure.technicalCause = technicalCause;
    throw failure;
  }
}
