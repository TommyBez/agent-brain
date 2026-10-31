import { z } from "zod";
import { fingerprint } from "../../canonical-json";
import {
  type GatewayCall,
  GatewayRequestError,
  gatewayRequest,
} from "../gateway";
import {
  type Answer,
  type Evaluate,
  type Evaluation,
  type EvaluationRequest,
  type Json,
  POLICY,
} from "./types";

export const JEV_MODEL = "typesafe-ai/jev-1.14.0";

const probability = z.number().min(0).max(1);
const tokenCount = z.number().int().nonnegative().nullable().optional();
const envelope = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({ inputTokens: tokenCount, outputTokens: tokenCount })
    .optional(),
  providerMetadata: z.json().optional(),
});
const booleanAnswer = z
  .object({ type: z.literal("boolean"), probability })
  .strict();
const choiceAnswer = z
  .object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), probability),
    // Gateway's standard answer omits confidence; TypeSafe provides it in metadata.
    confidence: probability.nullable().optional(),
  })
  .strict();

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sameKeys(left: object, right: object): boolean {
  const a = Object.keys(left).sort();
  const b = Object.keys(right).sort();
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

function validProbabilityMass(distribution: number[]): boolean {
  const sum = distribution.reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) <= 0.001) return true;
  // Observed Gateway responses round each choice probability to hundredths;
  // four/five complete options can therefore sum to 0.99. Accept only when
  // cent-quantized values admit an unrounded distribution summing to one.
  // Keep every reported value unchanged: normalization would alter judgments.
  const epsilon = Number.EPSILON * Math.max(1, distribution.length) * 16;
  if (
    !distribution.every(
      (value) => Math.abs(value - Math.round(value * 100) / 100) <= epsilon,
    )
  )
    return false;
  const lower = distribution.reduce(
    (total, value) => total + Math.max(0, value - 0.005),
    0,
  );
  const upper = distribution.reduce(
    (total, value) => total + Math.min(1, value + 0.005),
    0,
  );
  return lower <= 1 + epsilon && upper >= 1 - epsilon;
}

export type JevResponseFailure =
  | "envelope_shape"
  | "answer_keys"
  | "boolean_shape"
  | "choice_shape"
  | "choice_keys"
  | "choice_mass"
  | "choice_not_max"
  | "confidence";

/** Fixed reason codes diagnose protocol failures without echoing source text or values. */
function invalid(reason: JevResponseFailure): never {
  throw new JevResponseError(reason);
}

export class JevResponseError extends Error {
  constructor(readonly reason: JevResponseFailure) {
    super(`Jev returned an invalid evaluation response. [${reason}]`);
    this.name = "JevResponseError";
  }
}

export function parseEvaluation(
  request: EvaluationRequest,
  raw: unknown,
): Evaluation {
  const parsed = envelope.safeParse(raw);
  if (!parsed.success) invalid("envelope_shape");
  if (!sameKeys(request.questions, parsed.data.answers)) invalid("answer_keys");
  const response = parsed.data;
  const metadata = record(record(response.providerMetadata)?.typesafe);
  const confidences = record(metadata?.confidence);
  const answers: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === "boolean") {
      const answer = booleanAnswer.safeParse(response.answers[id]);
      if (!answer.success) invalid("boolean_shape");
      answers[id] = answer.data;
      continue;
    }
    const answer = choiceAnswer.safeParse(response.answers[id]);
    if (!answer.success) invalid("choice_shape");
    const { probabilities, choice } = answer.data;
    if (
      !sameKeys(question.criteria, probabilities) ||
      !Object.hasOwn(question.criteria, choice)
    )
      invalid("choice_keys");
    const distribution = Object.values(probabilities);
    if (!validProbabilityMass(distribution)) invalid("choice_mass");
    if (distribution.some((value) => value > probabilities[choice] + 0.000001))
      invalid("choice_not_max");
    const confidence = confidences?.[id] ?? answer.data.confidence ?? null;
    if (confidence !== null && !probability.safeParse(confidence).success)
      invalid("confidence");
    answers[id] = {
      type: "choice",
      choice,
      probabilities,
      confidence: confidence as number | null,
    };
  }
  return {
    model: response.model,
    promptVersion: fingerprint(request.questions),
    answers,
    inputTokens: response.usage?.inputTokens ?? null,
    outputTokens: response.usage?.outputTokens ?? null,
    ...(response.providerMetadata === undefined
      ? {}
      : { providerMetadata: response.providerMetadata as Json }),
  };
}

/** Used for injected evaluators too: a missing answer is never a negative judgment. */
export function validateEvaluation(
  request: EvaluationRequest,
  evaluation: Evaluation,
): Evaluation {
  return parseEvaluation(request, {
    model: evaluation.model,
    answers: evaluation.answers,
    usage: {
      inputTokens: evaluation.inputTokens,
      outputTokens: evaluation.outputTokens,
    },
    providerMetadata: evaluation.providerMetadata,
  });
}

/** HTTP contract: https://vercel.com/docs/ai-gateway/modalities/evaluation */
export async function evaluateJev(
  request: EvaluationRequest,
  send: GatewayCall = gatewayRequest,
  evaluatePart: Evaluate = (part) => evaluateJev(part, send),
): Promise<Evaluation> {
  const questionCount = Object.keys(request.questions).length;
  if (
    !questionCount ||
    questionCount > POLICY.questionsPerRequest ||
    JSON.stringify(request).length > POLICY.evaluationCharacters
  ) {
    throw new GatewayRequestError(
      "Jev request exceeds the evaluation policy limits.",
      { retryable: false },
    );
  }
  try {
    return parseEvaluation(
      request,
      await send<unknown>("evaluate", { model: JEV_MODEL, ...request }),
    );
  } catch (error) {
    // Character limits cannot predict Jev's tokenizer. Split only its explicit
    // capacity rejection, preserving full evidence and every choice per question.
    if (
      !(error instanceof GatewayRequestError) ||
      error.reason !== "max_tokens_exceeded" ||
      questionCount === 1
    )
      throw error;
    const entries = Object.entries(request.questions);
    const midpoint = Math.ceil(entries.length / 2);
    const batches: Evaluation[] = [];
    for (const questions of [
      entries.slice(0, midpoint),
      entries.slice(midpoint),
    ])
      batches.push(
        await evaluatePart({
          state: request.state,
          questions: Object.fromEntries(questions),
        }),
      );
    const usage = (field: "inputTokens" | "outputTokens") =>
      batches.some((batch) => batch[field] === null)
        ? null
        : batches.reduce((total, batch) => total + (batch[field] ?? 0), 0);
    return validateEvaluation(request, {
      model: JEV_MODEL,
      answers: Object.assign({}, ...batches.map((batch) => batch.answers)),
      inputTokens: usage("inputTokens"),
      outputTokens: usage("outputTokens"),
      providerMetadata: {
        batches: batches.map((batch) => batch.providerMetadata ?? null),
      },
    });
  }
}
