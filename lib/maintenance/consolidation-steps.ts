import { getStepMetadata } from "workflow";
import { applyConsolidationSnapshot } from "@/lib/brain/service";
import type { BrainLink, BrainPage } from "@/lib/brain/types";
import { assertOwner } from "@/lib/brain/utils";
import { getPool } from "@/lib/db";
import { exportBrain } from "@/lib/operations";
import { revalidateWorkspaceCache } from "@/lib/workspace/cache";
import {
  CANDIDATE_POLICY_HASH,
  candidateError,
} from "./consolidation-candidate";
import {
  assessCandidateAt,
  type CandidateHistoryEntry,
  type CandidateRunState,
  candidateMode,
  createCandidateRun,
  generateCandidateBatch,
  type PreparedCandidate,
  recordCandidateApplied,
  summarizeCandidateRun,
} from "./consolidation-run";

export async function prepareCandidateRun(ownerId: string) {
  "use step";
  assertOwner(ownerId);
  const mode = candidateMode(process.env.BRAIN_CONSOLIDATION_MODE);
  if (mode === "off") return createCandidateRun([], { mode });
  const [snapshot, recorded] = await Promise.all([
    exportBrain(ownerId),
    getPool().query<{ entry: CandidateHistoryEntry }>(
      `SELECT DISTINCT entry FROM brain_jobs,
       LATERAL jsonb_array_elements(COALESCE(result->'history', '[]'::jsonb)) entry
       WHERE owner_id=$1 AND kind='consolidation' AND result->>'policyHash'=$2
         AND entry->>'decision' IN ('reject','uncertain')`,
      [ownerId, CANDIDATE_POLICY_HASH],
    ),
  ]);
  // Export reads all pages and graph edges in one repeatable-read snapshot.
  const links = JSON.parse(JSON.stringify(snapshot.links)) as BrainLink[];
  const pages = JSON.parse(JSON.stringify(snapshot.pages)).map(
    (page: BrainPage) => ({
      ...page,
      embeddedAt: null,
      links: links.filter((link) => link.sourceId === page.id),
      backlinks: links.filter((link) => link.targetId === page.id),
    }),
  ) as BrainPage[];
  return createCandidateRun(pages, {
    mode,
    history: recorded.rows.map((row) => row.entry),
  });
}

export async function generateCandidateRun(state: CandidateRunState) {
  "use step";
  return generateCandidateBatch(state);
}
generateCandidateRun.maxRetries = 0;

export async function assessCandidateRun(
  state: CandidateRunState,
  index: number,
) {
  "use step";
  return assessCandidateAt(state, index);
}
assessCandidateRun.maxRetries = 0;

/** The writer is a separate retryable step with a stable revision receipt. */
export async function applyCandidateRun(
  ownerId: string,
  state: CandidateRunState,
  index: number,
  prepared: PreparedCandidate,
) {
  "use step";
  const entry = state.entries.find((item) => item.index === index);
  if (entry?.application === "applied") return state;
  if (
    state.mode !== "apply" ||
    state.writes >= state.maxWrites ||
    entry?.assessment?.finalDecision !== "accept" ||
    entry.pageId !== prepared.nextPage.id ||
    entry.proposalFingerprint !== prepared.proposalFingerprint ||
    entry.evidenceFingerprint !== prepared.evidenceFingerprint
  ) {
    throw new Error(
      "Only an accepted candidate can enter the snapshot writer.",
    );
  }
  const written = await applyConsolidationSnapshot(ownerId, prepared.nextPage, {
    operationKey: `workflow:${getStepMetadata().stepId}`,
    reason: "Consolidamento accettato da Jev e, sui criteri delegati, Kimi.",
  });
  revalidateWorkspaceCache(ownerId);
  return recordCandidateApplied(state, index, written);
}

export async function finishCandidateRun(
  state: CandidateRunState,
  failure = false,
) {
  "use step";
  if (failure) {
    state = { ...state, halted: true, fault: candidateError(null) };
  }
  const result = summarizeCandidateRun(state, state.writes > 0);
  if (result.invalid > 0) {
    result.report += ` ${result.invalid} proposte non valide scartate: il risultato non dimostra che il consolidamento sia esaurito.`;
  }
  return result;
}
