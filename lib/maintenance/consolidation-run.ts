import type { BrainPage } from "../brain/types";
import {
  CANDIDATE_POLICY_HASH,
  CANDIDATE_POLICY_VERSION,
  type CandidateError,
  candidateError,
  evaluateCandidate,
  prepareCandidateProposal,
} from "./consolidation-candidate";
import {
  type ConsolidationProposal,
  PROPOSAL_LIMITS,
  proposeConsolidation,
} from "./consolidation-proposals";

export type CandidateMode = "off" | "preview" | "apply";
export const CANDIDATE_RUN_LIMITS = {
  proposals: PROPOSAL_LIMITS.proposals,
  writes: 2,
  durationMs: 25 * 60_000,
  maxGenerationMs: 2 * 120_000,
  maxEvaluationMs: 30_000 + 120_000,
  observedTokens: 1_000_000,
} as const;
export type CandidateHistoryEntry = {
  policyHash: string;
  proposalFingerprint: string;
  evidenceFingerprint: string;
  decision: "reject" | "uncertain";
};
type Evaluation = Awaited<ReturnType<typeof evaluateCandidate>>;
export type PreparedCandidate = ReturnType<typeof prepareCandidateProposal>;
type Generation = Awaited<ReturnType<typeof proposeConsolidation>>;
export type CandidateRunEntry = {
  index: number;
  pageId: string;
  operation: string;
  decision:
    | Evaluation["finalDecision"]
    | "invalid"
    | "cached"
    | "duplicate_target";
  application: "not_applied" | "preview" | "applied";
  proposalFingerprint?: string;
  evidenceFingerprint?: string;
  assessment?: Evaluation;
  error?: CandidateError;
  beforeVersion?: number;
  writtenVersion?: number;
  /** Private job audit only, never inserted into a document. */
  diff?: { before: string; after: string };
};
export type CandidateRunState = {
  mode: CandidateMode;
  policyHash: string;
  policyVersion: string;
  snapshot: BrainPage[];
  history: CandidateHistoryEntry[];
  startedAt: number;
  deadlineAt: number;
  maxWrites: number;
  proposals: ConsolidationProposal[];
  generation: Pick<
    Generation,
    "model" | "usage" | "generationFault" | "responseDiagnostics"
  > | null;
  invalidGenerated: number;
  entries: CandidateRunEntry[];
  accepted: number;
  writes: number;
  inputTokens: number;
  outputTokens: number;
  reportedCostUsd: number;
  unknownCostCalls: number;
  unknownTokenCalls: number;
  budgetReached: boolean;
  halted: boolean;
  fault: CandidateError | null;
};

export function candidateMode(value: string | undefined): CandidateMode {
  if (value === undefined || value === "preview") return "preview";
  if (value === "off" || value === "apply") return value;
  throw new Error("BRAIN_CONSOLIDATION_MODE must be off, preview or apply.");
}

export function createCandidateRun(
  pages: BrainPage[],
  options: {
    mode?: CandidateMode;
    maxWrites?: number;
    history?: CandidateHistoryEntry[];
    now?: number;
  } = {},
): CandidateRunState {
  const maxWrites = options.maxWrites ?? CANDIDATE_RUN_LIMITS.writes;
  if (
    !Number.isSafeInteger(maxWrites) ||
    maxWrites < 1 ||
    maxWrites > CANDIDATE_RUN_LIMITS.proposals
  ) {
    throw new Error("Candidate write limit must be between one and eight.");
  }
  const now = options.now ?? Date.now();
  const mode = candidateMode(options.mode);
  return {
    mode,
    policyHash: CANDIDATE_POLICY_HASH,
    policyVersion: CANDIDATE_POLICY_VERSION,
    snapshot: structuredClone(pages),
    history: structuredClone(options.history ?? []),
    startedAt: now,
    deadlineAt: now + CANDIDATE_RUN_LIMITS.durationMs,
    maxWrites,
    proposals: [],
    generation: null,
    invalidGenerated: 0,
    entries: [],
    accepted: 0,
    writes: 0,
    inputTokens: 0,
    outputTokens: 0,
    reportedCostUsd: 0,
    unknownCostCalls: 0,
    unknownTokenCalls: 0,
    budgetReached: false,
    halted: mode === "off",
    fault: null,
  };
}

function account(
  state: CandidateRunState,
  input: number | undefined | null,
  output: number | undefined | null,
  cost: number | undefined | null,
) {
  state.inputTokens += input ?? 0;
  state.outputTokens += output ?? 0;
  if (input == null || output == null) state.unknownTokenCalls++;
  if (cost == null) state.unknownCostCalls++;
  else
    state.reportedCostUsd =
      (Math.round(state.reportedCostUsd * 1e12) + Math.round(cost * 1e12)) /
      1e12;
}

export async function generateCandidateBatch(
  previous: CandidateRunState,
  generate: (pages: BrainPage[]) => Promise<Generation> = (pages) =>
    proposeConsolidation(pages, { scope: "candidate-v1" }),
  now = Date.now(),
): Promise<CandidateRunState> {
  const state = structuredClone(previous);
  if (state.halted || state.generation) return state;
  if (now + CANDIDATE_RUN_LIMITS.maxGenerationMs > state.deadlineAt) {
    state.budgetReached = state.halted = true;
    return state;
  }
  try {
    const generated = await generate(structuredClone(state.snapshot));
    state.generation = {
      model: generated.model,
      usage: generated.usage,
      generationFault: generated.generationFault,
      responseDiagnostics: generated.responseDiagnostics,
    };
    account(
      state,
      generated.usage.inputTokens,
      generated.usage.outputTokens,
      generated.usage.costUsd,
    );
    if (generated.usage.physicalCalls !== undefined) {
      // A bounded producer can make selection plus one rewrite call. Totals
      // contain known usage only; retain every individual unknown explicitly.
      state.unknownCostCalls +=
        (generated.usage.unknownCostCalls ?? 0) -
        (generated.usage.costUsd == null ? 1 : 0);
      state.unknownTokenCalls += generated.usage.unknownTokenCalls ?? 0;
    } else if (
      generated.usage.inputTokensReported === false ||
      generated.usage.outputTokensReported === false
    )
      state.unknownTokenCalls++;
    state.invalidGenerated = generated.rejectedProposals.length;
    if (
      generated.generationFault ||
      generated.proposals.length > CANDIDATE_RUN_LIMITS.proposals
    ) {
      state.halted = true;
      const failure = generated.generationStages?.find(
        (stage) => stage.error,
      )?.error;
      state.fault = {
        kind: failure
          ? failure.status === null
            ? "transport_or_configuration"
            : "http"
          : "invalid_response",
        status: failure?.status ?? null,
        retryable: failure?.retryable ?? false,
        retryAfterMs: null,
      };
    } else state.proposals = generated.proposals;
  } catch (error) {
    state.halted = true;
    state.fault = candidateError(error);
    state.unknownCostCalls++;
    state.unknownTokenCalls++;
  }
  return state;
}

export async function assessCandidateAt(
  previous: CandidateRunState,
  index: number,
  evaluate: typeof evaluateCandidate = evaluateCandidate,
  now = Date.now(),
): Promise<{ state: CandidateRunState; prepared: PreparedCandidate | null }> {
  const state = structuredClone(previous);
  if (state.halted || state.entries.some((entry) => entry.index === index))
    return { state, prepared: null };
  if (
    state.accepted >= state.maxWrites ||
    now + CANDIDATE_RUN_LIMITS.maxEvaluationMs > state.deadlineAt ||
    state.inputTokens + state.outputTokens >=
      CANDIDATE_RUN_LIMITS.observedTokens
  ) {
    state.budgetReached = state.halted = true;
    return { state, prepared: null };
  }
  const proposal = state.proposals[index];
  if (!proposal) throw new Error("Unknown candidate proposal index.");
  const entry: CandidateRunEntry = {
    index,
    pageId: proposal.pageId,
    operation: proposal.operation,
    decision: "invalid",
    application: "not_applied",
  };
  state.entries.push(entry);
  if (
    state.entries.some(
      (prior) => prior !== entry && prior.pageId === proposal.pageId,
    )
  ) {
    entry.decision = "duplicate_target";
    return { state, prepared: null };
  }
  let prepared: PreparedCandidate;
  try {
    prepared = prepareCandidateProposal(state.snapshot, proposal);
  } catch {
    return { state, prepared: null };
  }
  entry.proposalFingerprint = prepared.proposalFingerprint;
  entry.evidenceFingerprint = prepared.evidenceFingerprint;
  entry.beforeVersion = prepared.beforePage.version;
  entry.diff = {
    before: prepared.beforePage.markdown,
    after: prepared.nextPage.markdown,
  };
  if (
    state.history.some(
      (prior) =>
        prior.policyHash === state.policyHash &&
        prior.proposalFingerprint === prepared.proposalFingerprint &&
        prior.evidenceFingerprint === prepared.evidenceFingerprint,
    )
  ) {
    entry.decision = "cached";
    return { state, prepared: null };
  }
  let assessment: Evaluation;
  try {
    assessment = await evaluate(prepared.input);
  } catch (error) {
    state.halted = true;
    entry.decision = "error";
    state.fault = entry.error = candidateError(error);
    state.unknownCostCalls++;
    state.unknownTokenCalls++;
    return { state, prepared: null };
  }
  entry.assessment = assessment;
  entry.decision = assessment.finalDecision;
  if (assessment.jev.status === "success") {
    const usage = assessment.jev.result.usage;
    account(state, usage.inputTokens, usage.outputTokens, usage.gateway?.cost);
    state.unknownCostCalls +=
      assessment.jev.result.transportFailures?.length ?? 0;
    state.unknownTokenCalls +=
      assessment.jev.result.transportFailures?.length ?? 0;
  } else {
    const attempts = assessment.jev.error.transportFailures?.length || 1;
    state.unknownCostCalls += attempts;
    state.unknownTokenCalls += attempts;
  }
  if (assessment.kimi) {
    const usage =
      assessment.kimi.status === "success"
        ? assessment.kimi.result.usage
        : assessment.kimi.error.diagnostic?.usage;
    account(state, usage?.inputTokens, usage?.outputTokens, usage?.costUsd);
    if (usage?.physicalCalls !== undefined) {
      state.unknownCostCalls +=
        (usage.unknownCostCalls ?? 0) - (usage.costUsd == null ? 1 : 0);
      state.unknownTokenCalls +=
        (usage.unknownTokenCalls ?? 0) -
        (usage.inputTokens == null || usage.outputTokens == null ? 1 : 0);
    }
  }
  if (assessment.finalDecision === "error") {
    state.halted = true;
    state.fault =
      assessment.jev.status === "error"
        ? assessment.jev.error
        : assessment.kimi?.status === "error"
          ? assessment.kimi.error
          : candidateError(null);
  } else if (
    assessment.finalDecision === "reject" ||
    assessment.finalDecision === "uncertain"
  ) {
    state.history.push({
      policyHash: state.policyHash,
      proposalFingerprint: prepared.proposalFingerprint,
      evidenceFingerprint: prepared.evidenceFingerprint,
      decision: assessment.finalDecision,
    });
  } else {
    state.accepted++;
    if (state.mode === "preview") entry.application = "preview";
    return { state, prepared };
  }
  return { state, prepared: null };
}

export function recordCandidateApplied(
  previous: CandidateRunState,
  index: number,
  page: BrainPage,
): CandidateRunState {
  const state = structuredClone(previous);
  const entry = state.entries.find((item) => item.index === index);
  if (
    state.mode !== "apply" ||
    entry?.decision !== "accept" ||
    entry.pageId !== page.id
  )
    throw new Error("An accepted candidate is required for writing.");
  if (entry.application !== "applied") state.writes++;
  entry.application = "applied";
  entry.writtenVersion = page.version;
  return state;
}

export function summarizeCandidateRun(
  state: CandidateRunState,
  persisted = false,
) {
  return {
    policyHash: state.policyHash,
    policyVersion: state.policyVersion,
    mode: state.mode,
    persisted,
    writes: state.writes,
    accepted: state.accepted,
    proposed: state.proposals.length,
    evaluated: state.entries.filter((entry) => entry.assessment).length,
    cached: state.entries.filter((entry) => entry.decision === "cached").length,
    invalid:
      state.invalidGenerated +
      state.entries.filter(
        (entry) =>
          entry.decision === "invalid" || entry.decision === "duplicate_target",
      ).length,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    reportedCostUsd: state.reportedCostUsd,
    unknownCostCalls: state.unknownCostCalls,
    unknownTokenCalls: state.unknownTokenCalls,
    budgetReached: state.budgetReached,
    fault: state.fault,
    generation: state.generation,
    entries: state.entries,
    history: state.history.filter(
      (item) =>
        item.policyHash === state.policyHash &&
        state.entries.some(
          (entry) =>
            (entry.decision === "reject" || entry.decision === "uncertain") &&
            entry.proposalFingerprint === item.proposalFingerprint &&
            entry.evidenceFingerprint === item.evidenceFingerprint,
        ),
    ),
    limits: { ...CANDIDATE_RUN_LIMITS, writes: state.maxWrites },
    report: `${state.mode}: ${state.proposals.length} proposte, ${state.accepted} accettate, ${state.writes} applicate; ${state.fault ? "interrotto per errore tecnico" : state.budgetReached ? "limite raggiunto" : "completato"}.`,
  };
}

/** Shared isolated runner. Default apply changes copies only; storage is an explicit dependency. */
export async function runConsolidationSnapshot(
  pages: BrainPage[],
  options: Parameters<typeof createCandidateRun>[1] = {},
  deps: {
    generate?: Parameters<typeof generateCandidateBatch>[1];
    evaluate?: typeof evaluateCandidate;
    apply?: (page: BrainPage, index: number) => Promise<BrainPage>;
    now?: () => number;
  } = {},
) {
  const now = deps.now ?? Date.now;
  let state = await generateCandidateBatch(
    createCandidateRun(pages, { ...options, now: now() }),
    deps.generate,
    now(),
  );
  let nextPages = structuredClone(pages);
  for (
    let index = 0;
    index < state.proposals.length && !state.halted;
    index++
  ) {
    const outcome = await assessCandidateAt(state, index, deps.evaluate, now());
    state = outcome.state;
    if (outcome.prepared && state.mode === "apply") {
      try {
        const page = deps.apply
          ? await deps.apply(outcome.prepared.nextPage, index)
          : outcome.prepared.nextPage;
        state = recordCandidateApplied(state, index, page);
        nextPages = nextPages.map((prior) =>
          prior.id === page.id ? page : prior,
        );
      } catch (error) {
        state.halted = true;
        state.fault = candidateError(error);
      }
    }
  }
  return {
    pages: nextPages,
    report: summarizeCandidateRun(
      state,
      Boolean(deps.apply) && state.writes > 0,
    ),
  };
}
