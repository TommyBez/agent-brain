import { resolve, search } from "../../brain/search";
import { embeddingModel } from "../../brain/utils";
import { getPool } from "../../db";
import { lockTaskForLinks } from "../../tasks/links";
import { lexicalQuery, taskSemanticFingerprint } from "../../tasks/retrieval";
import { BudgetExhaustedError } from "../consolidator/budget";
import {
  evaluatePersisted,
  evaluationCacheKey,
} from "../consolidator/evaluation-cache";
import {
  findConsolidationRecord,
  saveConsolidationRecord,
} from "../consolidator/store";
import type { GatewayCall } from "../gateway";
import {
  type AnalyzedCandidate,
  applyLinkAnalysis,
  type LinkAnalysis,
} from "./apply";
import {
  type CandidateRef,
  excerptFor,
  linkInputsFingerprint,
  linkUnitId,
  selectCandidates,
  taskLinkKeys,
  titleNames,
} from "./candidates";
import type { AutoApplyState } from "./gate";
import { TASK_LINK_POLICY } from "./policy";
import { buildLinkRequest, type JevPage, readJudgments } from "./questions";
import {
  decidedPageIds,
  loadEvidencePages,
  loadTaskVector,
  nearestPassages,
  projectNeighborhood,
  type StoredTaskVector,
  saveLinkInputs,
} from "./store";

// The Jev pass for one open task (§8.3): candidates, LinkUnit, one cached Jev
// request, apply. Step adapters supply the budgeted gateway.

export const JEV_LINK_STATUSES = [
  "ready",
  "in_progress",
  "needs_input",
  "blocked",
  "in_review",
  "on_hold",
] as const;

export interface LinkTaskResult {
  considered: boolean;
  reused: boolean;
  requests: number;
  outcome: "applied" | "replayed" | "deferred" | "skipped";
  suggested: number;
  activated: number;
  retracted: number;
}

const RESOLVE_CONFIDENCE = 0.6;

async function resolvedNames(ownerId: string, title: string) {
  const refs: CandidateRef[] = [];
  for (const name of titleNames(title)) {
    const { match, candidates } = await resolve(ownerId, { name, limit: 3 });
    const page =
      match ??
      candidates.find(
        (candidate) => candidate.confidence >= RESOLVE_CONFIDENCE,
      );
    if (page) refs.push({ pageId: page.id, source: "resolve" });
  }
  return refs;
}

/**
 * Candidates, their evidence fingerprints and excerpts for one task. Without
 * a current stored vector, retrieval is text and graph (never the query key).
 */
export async function taskCandidates(
  ownerId: string,
  task: {
    id: string;
    title: string;
    projectPageId: string | null;
  },
  vector: StoredTaskVector | null,
): Promise<{
  candidates: AnalyzedCandidate[];
  /** Jev state of each candidate, in the same order. */
  pages: JevPage[];
}> {
  const db = getPool();
  const excluded = await decidedPageIds(db, ownerId, task.id);
  if (task.projectPageId) excluded.push(task.projectPageId);
  const [neighborhood, retrieval, resolved] = await Promise.all([
    task.projectPageId
      ? projectNeighborhood(db, ownerId, task.projectPageId)
      : Promise.resolve([]),
    search(
      ownerId,
      {
        query: lexicalQuery(task.title),
        limit: TASK_LINK_POLICY.maxCandidates,
        expandGraph: false,
        ...(vector
          ? {
              embedding: vector.embedding,
              embeddingModel: vector.embeddingModel,
            }
          : {}),
      },
      { serverEmbedding: false },
    ).then(({ results }) =>
      results.map(
        (hit): CandidateRef => ({
          pageId: hit.id,
          source: "retrieval",
          ...(hit.matchedPassage ? { passage: hit.matchedPassage } : {}),
        }),
      ),
    ),
    resolvedNames(ownerId, task.title),
  ]);
  const refs = selectCandidates({
    neighborhood,
    retrieval,
    resolved,
    excluded,
  });
  const pages = await loadEvidencePages(
    db,
    ownerId,
    refs.map((ref) => ref.pageId),
  );
  const unmatched = refs
    .filter(
      (ref) => !ref.passage || ref.passage.endOffset <= ref.passage.startOffset,
    )
    .map((ref) => ref.pageId);
  const nearest = vector
    ? await nearestPassages(db, ownerId, unmatched, vector)
    : new Map();
  const candidates: AnalyzedCandidate[] = [];
  const states: JevPage[] = [];
  for (const ref of refs) {
    const page = pages.get(ref.pageId);
    if (!page) continue;
    const excerpt = excerptFor(
      page.markdown,
      ref.passage && ref.passage.endOffset > ref.passage.startOffset
        ? ref.passage
        : nearest.get(ref.pageId),
    );
    candidates.push({
      pageId: page.id,
      type: page.type,
      version: page.version,
      fingerprint: page.fingerprint,
      source: ref.source,
      startOffset: excerpt.startOffset,
      endOffset: excerpt.endOffset,
      judgment: { relevant: 0 },
    });
    states.push({
      title: page.title,
      type: page.type,
      summary: page.summary,
      excerpt: excerpt.text,
    });
  }
  return { candidates, pages: states };
}

/**
 * One task: reuse the analysis of an unchanged LinkUnit (zero requests), or
 * pay one Jev request through `gateway`, then apply under the run's receipt.
 * A completed pass records its inputs against `corpus`, the plan's corpus.
 */
export async function linkTask(
  ownerId: string,
  runId: string,
  taskId: string,
  agentId: string,
  gateway: GatewayCall,
  autoApply: AutoApplyState,
  corpus: string,
): Promise<LinkTaskResult> {
  const result: LinkTaskResult = {
    considered: false,
    reused: false,
    requests: 0,
    outcome: "skipped",
    suggested: 0,
    activated: 0,
    retracted: 0,
  };
  const db = getPool();
  const task = await lockTaskForLinks(db, ownerId, taskId, false);
  if (
    !task ||
    task.archivedAt !== null ||
    !(JEV_LINK_STATUSES as readonly string[]).includes(task.status)
  )
    return result;
  result.considered = true;
  const taskFingerprint = taskSemanticFingerprint(task);
  const stored = await loadTaskVector(db, ownerId, taskId);
  const vector =
    stored?.fingerprint === taskFingerprint &&
    stored.embeddingModel === embeddingModel()
      ? stored
      : null;
  const { candidates, pages } = await taskCandidates(ownerId, task, vector);
  const policyVersion = TASK_LINK_POLICY.version;
  const unitId = linkUnitId({
    policyVersion,
    taskId,
    taskFingerprint,
    candidateFingerprints: candidates.map((candidate) => candidate.fingerprint),
  });
  const analysisKey = taskLinkKeys.analysis(unitId);
  let analysis = await findConsolidationRecord<LinkAnalysis>(
    ownerId,
    analysisKey,
  );
  if (analysis) result.reused = true;
  else {
    let evaluationKey: string | null = null;
    if (candidates.length) {
      const request = buildLinkRequest(
        {
          title: task.title,
          description: task.description,
          acceptanceCriteria: task.acceptanceCriteria,
        },
        pages,
      );
      evaluationKey = evaluationCacheKey(request);
      // A call the budget refuses never reaches the provider.
      const counted: GatewayCall = async (path, body) => {
        try {
          const response = await gateway<unknown>(path, body);
          result.requests++;
          return response as never;
        } catch (error) {
          if (!(error instanceof BudgetExhaustedError)) result.requests++;
          throw error;
        }
      };
      const evaluation = await evaluatePersisted(
        ownerId,
        runId,
        request,
        counted,
        { logEvent: "task_links.evaluation_error" },
      );
      const judgments = readJudgments(candidates, evaluation.answers);
      candidates.forEach((candidate, index) => {
        candidate.judgment = judgments[index];
      });
    }
    analysis = {
      unitId,
      policyVersion,
      taskId,
      taskFingerprint,
      evaluationKey,
      candidates,
    };
    await saveConsolidationRecord(ownerId, runId, analysisKey, analysis);
  }
  const applied = await applyLinkAnalysis(
    ownerId,
    agentId,
    analysis,
    autoApply,
    runId,
  );
  result.outcome = applied.status;
  if (applied.status !== "deferred")
    await saveLinkInputs(
      db,
      ownerId,
      taskId,
      linkInputsFingerprint({
        policyVersion,
        taskFingerprint,
        corpus,
        vectorModel: vector?.embeddingModel ?? null,
      }),
    );
  for (const change of applied.changes) {
    if (change.status === "suggested" && change.previous !== "suggested")
      result.suggested++;
    if (change.status === "active" && change.previous !== "active")
      result.activated++;
    if (change.status === "retracted" && change.previous !== "retracted")
      result.retracted++;
  }
  return result;
}
