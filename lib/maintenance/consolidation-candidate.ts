import { createHash } from "node:crypto";
import type { BrainPage } from "../brain/types";
import { DEFECT_CONSOLIDATION_QUESTIONS } from "./consolidation-defect-questions";
import { markdownDestinations } from "./consolidation-links";
import {
  CANDIDATE_OPERATIONS,
  type CandidateProposal,
  type ConsolidationProposal,
  PROPOSAL_LIMITS,
  validateAndApplyProposal,
} from "./consolidation-proposals";
import {
  CONSOLIDATION_CRITERIA,
  CONSOLIDATION_QUESTIONS_V2,
  type ConsolidationCriterion as Criterion,
} from "./consolidation-rubric";
import { GatewayRequestError } from "./gateway";
import {
  type ConsolidationEvaluation,
  type ConsolidationEvaluationInput,
  evaluateConsolidationProposal,
  JEV_MODEL,
  type JevTransportFailure,
} from "./jev";
import {
  JEV_RECOVERY,
  JevRecoveryError,
  recoverJevTransport,
} from "./jev-recovery";
import {
  KIMI_EVALUATOR_SETTINGS,
  type KimiEvaluation,
  KimiResponseError,
} from "./kimi-evaluator";
import { KIMI_SOURCE_AUDIT_CONTRACT } from "./kimi-source-audit";
import { KIMI_SOURCE_CHALLENGE_CONTRACT } from "./kimi-source-challenge";
import {
  evaluateWithKimiSourceContract,
  KIMI_SOURCE_CONTRACT,
  KIMI_SOURCE_CONTRACT_CLARIFICATION,
} from "./kimi-source-contract";

export const CANDIDATE_POLICY_VERSION = "consolidation-candidate-v3";
export const CANDIDATE_INPUT_LIMIT = 250_000;
export const CANDIDATE_BANDS = Object.freeze({
  supported_by_evidence: Object.freeze({
    allowBelow: 0.12,
    rejectAtOrAbove: 0.94,
  }),
  preserves_distinct_information: Object.freeze({
    allowBelow: 0.23,
    rejectAtOrAbove: 0.79,
  }),
  no_new_human_action: Object.freeze({
    allowBelow: 0.49,
    rejectAtOrAbove: 0.9,
  }),
  meaningful_improvement: Object.freeze({
    allowBelow: 0.09,
    rejectAtOrAbove: 0.72,
  }),
});

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export const CANDIDATE_POLICY_HASH = hash({
  version: CANDIDATE_POLICY_VERSION,
  questions: DEFECT_CONSOLIDATION_QUESTIONS,
  bands: CANDIDATE_BANDS,
  jevModel: JEV_MODEL,
  jevRecovery: JEV_RECOVERY,
  kimi: KIMI_EVALUATOR_SETTINGS,
  rubric: CONSOLIDATION_QUESTIONS_V2,
  clarification: KIMI_SOURCE_CONTRACT_CLARIFICATION,
  sourceReview: KIMI_SOURCE_CONTRACT,
  sourceAudit: KIMI_SOURCE_AUDIT_CONTRACT,
  sourceChallenge: KIMI_SOURCE_CHALLENGE_CONTRACT,
  operations: CANDIDATE_OPERATIONS,
  decision:
    "round risk to 12 decimals; red rejects; all green accepts; otherwise Kimi judges gray; only all pass applies",
});

export type CandidateVerdict =
  | "pass"
  | "fail"
  | "uncertain"
  | "error"
  | "not_evaluated";
export type CandidateDecision = "accept" | "reject" | "uncertain" | "error";
export type CandidateError = {
  kind:
    | "invalid_input"
    | "invalid_response"
    | "http"
    | "transport_or_configuration"
    | "unexpected";
  status: number | null;
  retryable: boolean;
  retryAfterMs: number | null;
  transportFailures?: JevTransportFailure[];
  diagnostic?: {
    stage: string;
    reasonCode: string;
    usage: KimiEvaluation["usage"];
    responseId: string | null;
    responseModel: string | null;
    latencyMs: number;
    reviewReceipts?: KimiEvaluation["reviewReceipts"];
  };
};
export type CandidateOutcome<T> =
  | { status: "success"; result: T }
  | { status: "error"; error: CandidateError };
export type CandidateDependencies = {
  jev(input: ConsolidationEvaluationInput): Promise<ConsolidationEvaluation>;
  kimi(
    input: ConsolidationEvaluationInput,
    selected: Criterion[],
  ): Promise<KimiEvaluation>;
};
/** Replays an already sanitized model receipt without another provider call. */
export class CandidateRecordedError extends Error {
  constructor(readonly diagnostic: CandidateError) {
    super("Recorded candidate evaluation failed.");
    this.name = "CandidateRecordedError";
  }
}
const mapCriteria = <T>(fn: (key: Criterion) => T) =>
  Object.fromEntries(
    CONSOLIDATION_CRITERIA.map((key) => [key, fn(key)]),
  ) as Record<Criterion, T>;

export function candidateError(error: unknown): CandidateError {
  if (error instanceof CandidateRecordedError)
    return structuredClone(error.diagnostic);
  const gateway = error instanceof GatewayRequestError ? error : null;
  const technicalCause =
    error instanceof KimiResponseError ? error.technicalCause : undefined;
  return {
    kind:
      technicalCause?.kind ??
      (error instanceof KimiResponseError
        ? "invalid_response"
        : gateway?.status !== null && gateway?.status !== undefined
          ? "http"
          : gateway
            ? /invalid/.test(gateway.message)
              ? "invalid_response"
              : "transport_or_configuration"
            : "unexpected"),
    status: technicalCause?.status ?? gateway?.status ?? null,
    retryable: technicalCause?.retryable ?? gateway?.retryable ?? false,
    retryAfterMs: technicalCause?.retryAfterMs ?? gateway?.retryAfterMs ?? null,
    ...(error instanceof JevRecoveryError
      ? { transportFailures: error.transportFailures }
      : {}),
    ...(error instanceof KimiResponseError
      ? {
          diagnostic: {
            stage: error.stage,
            reasonCode: error.reasonCode,
            usage: error.usage,
            responseId: error.responseId,
            responseModel: error.responseModel,
            latencyMs: error.latencyMs,
            ...(error.reviewReceipts
              ? { reviewReceipts: error.reviewReceipts }
              : {}),
          },
        }
      : {}),
  };
}

/** Four-field, complete JSON snapshot. No scores, labels or caller metadata cross this boundary. */
function cleanInput(
  input: ConsolidationEvaluationInput,
): ConsolidationEvaluationInput {
  const serialized = JSON.stringify({
    before: input.before,
    after: input.after,
    evidence: input.evidence,
    operation: input.operation,
  });
  if (serialized.length > CANDIDATE_INPUT_LIMIT)
    throw new Error("Candidate input exceeds complete-input limit.");
  const clean = JSON.parse(serialized);
  if (Object.keys(clean).length !== 4)
    throw new Error("Candidate input must include all four fields.");
  return clean;
}

/** Same frozen decision policy for the live benchmark and nightly candidate. No storage access. */
export async function evaluateCandidate(
  input: ConsolidationEvaluationInput,
  deps: CandidateDependencies = {
    jev: (state) =>
      recoverJevTransport((_attempt, timeoutMs) =>
        evaluateConsolidationProposal(state, {
          questions: DEFECT_CONSOLIDATION_QUESTIONS,
          timeoutMs,
        }),
      ),
    kimi: (state, selected) =>
      evaluateWithKimiSourceContract(state, selected, "clarified"),
  },
) {
  let clean: ConsolidationEvaluationInput;
  let jev: CandidateOutcome<ConsolidationEvaluation>;
  try {
    clean = cleanInput(input);
  } catch {
    jev = {
      status: "error",
      error: {
        kind: "invalid_input",
        status: null,
        retryable: false,
        retryAfterMs: null,
      },
    };
    return failedCandidate(jev);
  }
  try {
    const result = await deps.jev(structuredClone(clean));
    if (
      Object.keys(result.answers).length !== CONSOLIDATION_CRITERIA.length ||
      CONSOLIDATION_CRITERIA.some(
        (key) =>
          !Number.isFinite(result.answers[key]) ||
          result.answers[key] < 0 ||
          result.answers[key] > 1,
      )
    ) {
      throw new GatewayRequestError("Jev returned invalid candidate scores.", {
        retryable: false,
      });
    }
    jev = { status: "success", result };
  } catch (error) {
    return failedCandidate({ status: "error", error: candidateError(error) });
  }
  const risk = mapCriteria((key) =>
    Number(jev.result.answers[key].toFixed(12)),
  );
  const jevCriteria = mapCriteria((key) =>
    risk[key] < CANDIDATE_BANDS[key].allowBelow
      ? ("pass" as const)
      : risk[key] >= CANDIDATE_BANDS[key].rejectAtOrAbove
        ? ("fail" as const)
        : ("defer" as const),
  );
  const red = CONSOLIDATION_CRITERIA.some((key) => jevCriteria[key] === "fail");
  const selected = red
    ? []
    : CONSOLIDATION_CRITERIA.filter((key) => jevCriteria[key] === "defer");
  let kimi: CandidateOutcome<KimiEvaluation> | null = null;
  if (selected.length) {
    try {
      const result = await deps.kimi(structuredClone(clean), [...selected]);
      if (
        Object.keys(result.judgments).length !== selected.length ||
        selected.some(
          (key) =>
            !["pass", "fail", "uncertain"].includes(
              result.judgments[key]?.verdict ?? "",
            ),
        )
      ) {
        throw new GatewayRequestError(
          "Kimi returned invalid candidate judgments.",
          { retryable: false },
        );
      }
      kimi = { status: "success", result };
    } catch (error) {
      kimi = { status: "error", error: candidateError(error) };
    }
  }
  const finalCriteria = mapCriteria<CandidateVerdict>((key) => {
    if (jevCriteria[key] !== "defer") return jevCriteria[key];
    if (red) return "not_evaluated";
    return kimi?.status === "success"
      ? (kimi.result.judgments[key]?.verdict ?? "error")
      : "error";
  });
  const verdicts = Object.values(finalCriteria);
  const finalDecision: CandidateDecision = verdicts.includes("error")
    ? "error"
    : verdicts.includes("fail")
      ? "reject"
      : verdicts.includes("uncertain")
        ? "uncertain"
        : "accept";
  return {
    policyHash: CANDIDATE_POLICY_HASH,
    jev,
    kimi,
    risk,
    route: red
      ? ("reject" as const)
      : selected.length
        ? ("defer" as const)
        : ("accept" as const),
    jevCriteria,
    finalCriteria,
    finalDecision,
    selected,
  };
}

function failedCandidate(jev: CandidateOutcome<ConsolidationEvaluation>) {
  return {
    policyHash: CANDIDATE_POLICY_HASH,
    jev,
    kimi: null,
    risk: null,
    route: "error" as const,
    jevCriteria: mapCriteria(() => "error" as const),
    finalCriteria: mapCriteria<CandidateVerdict>(() => "error"),
    finalDecision: "error" as CandidateDecision,
    selected: [] as Criterion[],
  };
}

/** Prepare only from the supplied run snapshot; versions are audit/input consistency, never a later concurrency check. */
export function prepareCandidateProposal(
  pages: BrainPage[],
  proposal: ConsolidationProposal,
) {
  if (
    !CANDIDATE_OPERATIONS.some((operation) => operation === proposal.operation)
  ) {
    throw new Error(
      "Consolidation proposal rejected: operation outside candidate scope.",
    );
  }
  if (JSON.stringify(pages).length > PROPOSAL_LIMITS.corpusCharacters) {
    throw new Error(
      "Consolidation snapshot exceeds the complete-corpus input limit.",
    );
  }
  const applied = validateAndApplyProposal(pages, proposal, pages);
  const nextReferences = markdownDestinations(applied.after.markdown);
  for (const destination of markdownDestinations(applied.before.markdown)) {
    if (!nextReferences.has(destination)) {
      throw new Error(
        "Consolidation proposal rejected: Markdown link removal.",
      );
    }
  }
  const sources = pages.map((page) => ({
    pageId: page.id,
    version: page.version,
    title: page.title,
    summary: page.summary,
    markdown: page.markdown,
    links: structuredClone(page.links),
  }));
  const input = cleanInput({
    before: applied.before,
    after: applied.after,
    evidence: { citations: structuredClone(proposal.evidence), sources },
    operation: structuredClone(proposal),
  });
  const edit = proposal as CandidateProposal;
  return {
    input,
    beforePage: structuredClone(applied.before),
    nextPage: structuredClone(applied.after),
    proposalFingerprint: hash({
      pageId: edit.pageId,
      operation: edit.operation,
      before: edit.before,
      after: edit.after,
    }),
    evidenceFingerprint: hash(
      sources
        .map(({ version: _version, ...source }) => source)
        .sort((a, b) => a.pageId.localeCompare(b.pageId)),
    ),
  };
}
