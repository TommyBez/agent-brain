import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getQueryEmbedding } from "../brain/embeddings";
import type { Database } from "../brain/pages";
import { search } from "../brain/search";
import type { SearchResult } from "../brain/types";
import { fingerprint } from "../canonical-json";
import { getPool, transaction } from "../db";
import {
  type ExistingTaskLink,
  existingTaskLinks,
  type LinkChange,
  type LockedLinkTask,
  lockTaskForLinks,
  type MachineLinkWrite,
  recordLinkChanges,
  writeMachineLinks,
} from "./links";

// Retrieval suggestions (§8.1): the top results of search() for a task,
// written as `rule` context links with evidence.basis 'retrieval'. They stay
// suggestions; only the owner accepts or rejects them.

export const RETRIEVAL_POLICY = {
  version: "task-retrieval-v1",
  /** New suggestions come from the first five unlinked results. */
  suggest: 5,
  /** An undecided suggestion survives while its page stays in the top ten. */
  keep: 10,
  digestCharacters: 1_000,
  embeddingCharacters: 4_000,
  lexicalTerms: 8,
} as const;

export interface TaskContent {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  projectPageId: string | null;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** Title, criteria and description, at most 1000 characters (§8.1). */
export function taskDigest(task: Omit<TaskContent, "projectPageId">): string {
  // `/pages/<ref>` mentions are already links; their paths are not content.
  return squash(
    [task.title, ...task.acceptanceCriteria, task.description]
      .filter(Boolean)
      .join("\n")
      .replace(/\/pages\/[\w/-]+/g, " "),
  ).slice(0, RETRIEVAL_POLICY.digestCharacters);
}

/** The task text the nightly vector embeds (≤4000 characters, §8.3). */
export function taskEmbeddingText(
  task: Omit<TaskContent, "projectPageId">,
): string {
  return [task.title, task.acceptanceCriteria.join("\n"), task.description]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, RETRIEVAL_POLICY.embeddingCharacters);
}

/** Semantic identity of a task: content and project only, never status,
 * claims, leases, version, parties, due dates or timestamps (§8.3). */
export function taskSemanticFingerprint(task: TaskContent): string {
  return fingerprint({
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    projectId: task.projectPageId,
  });
}

const STOPWORDS = new Set(
  (
    "and are but can for from has have its not one per our the this that was " +
    "were will with what when which who why how all any into onto over than " +
    "then them they you your about after before also more most such only " +
    "agli alla alle allo anche come con cui dai dal dall dalla dalle degli dei " +
    "del dell della delle dello deve devono dopo era essere fra gli hanno " +
    "negli dagli sugli " +
    "lei lui nei nel nell nella nelle nello non per perché più poi quale " +
    "quando quella quelle quello questa queste questo sono sua sue sui sul " +
    "sull sulla sulle suo tra una uno che chi ogni senza sia stato stata " +
    "verso entro fare fatto"
  ).split(" "),
);

/** Distinctive words of `text` as a websearch OR query; Postgres would AND them. */
export function lexicalQuery(
  text: string,
  maxTerms: number = RETRIEVAL_POLICY.lexicalTerms,
): string {
  const terms: string[] = [];
  for (const match of text
    .normalize("NFKC")
    .toLocaleLowerCase("it-IT")
    .matchAll(/[\p{L}\p{N}]{3,}/gu)) {
    const term = match[0];
    if (STOPWORDS.has(term) || terms.includes(term)) continue;
    terms.push(term);
    if (terms.length >= maxTerms) break;
  }
  return terms.length ? terms.join(" or ") : squash(text).slice(0, 200);
}

export type RetrievalHit = Pick<SearchResult, "id" | "version"> & {
  matchedPassage?: SearchResult["matchedPassage"];
};

export interface RetrievalPlan {
  suggest: { pageId: string; rank: number; hit: RetrievalHit }[];
  retract: {
    pageId: string;
    reason: "outside_top_10" | "linked_otherwise";
  }[];
}

const isRetrievalRow = (link: ExistingTaskLink) =>
  link.origin === "rule" && link.evidence.basis === "retrieval";

/**
 * Pure retrieval policy. A page with any other link (or a decided, rejected
 * retrieval link) is never suggested; undecided suggestions leaving the top
 * ten, or whose page gained another live link, are retracted; the first five
 * unlinked results are (re)suggested.
 */
export function planRetrieval(
  results: RetrievalHit[],
  existing: ExistingTaskLink[],
  excludedPageIds: readonly string[] = [],
): RetrievalPlan {
  const blocked = new Set(excludedPageIds);
  for (const link of existing)
    if (
      !isRetrievalRow(link) ||
      link.decidedAt !== null ||
      !(link.status === "suggested" || link.status === "retracted")
    )
      blocked.add(link.pageId);
  const top = results.slice(0, RETRIEVAL_POLICY.keep);
  const suggest: RetrievalPlan["suggest"] = [];
  top.forEach((hit, index) => {
    if (suggest.length >= RETRIEVAL_POLICY.suggest || blocked.has(hit.id))
      return;
    if (suggest.some((item) => item.pageId === hit.id)) return;
    suggest.push({ pageId: hit.id, rank: index + 1, hit });
  });
  const kept = new Set(top.map((hit) => hit.id));
  const linkedOtherwise = new Set(
    existing
      .filter(
        (link) =>
          !isRetrievalRow(link) &&
          (link.status === "active" || link.status === "suggested"),
      )
      .map((link) => link.pageId),
  );
  const retract: RetrievalPlan["retract"] = [];
  for (const link of existing) {
    if (
      !isRetrievalRow(link) ||
      link.status !== "suggested" ||
      link.decidedAt !== null ||
      link.role !== "context"
    )
      continue;
    if (linkedOtherwise.has(link.pageId))
      retract.push({ pageId: link.pageId, reason: "linked_otherwise" });
    else if (!kept.has(link.pageId))
      retract.push({ pageId: link.pageId, reason: "outside_top_10" });
  }
  return { suggest, retract };
}

function passageEvidence(hit: RetrievalHit) {
  const passage = hit.matchedPassage;
  return passage && passage.endOffset > passage.startOffset
    ? { startOffset: passage.startOffset, endOffset: passage.endOffset }
    : {};
}

/** Link writes for a plan; unchanged suggestions are left as they are. */
export function retrievalWrites(
  plan: RetrievalPlan,
  existing: ExistingTaskLink[],
  mode: "sync" | "nightly",
): MachineLinkWrite[] {
  const writes: MachineLinkWrite[] = [];
  for (const item of plan.suggest) {
    const current = existing.find(
      (link) => link.pageId === item.pageId && link.role === "context",
    );
    if (current?.status === "suggested") continue;
    writes.push({
      pageId: item.pageId,
      role: "context",
      origin: "rule",
      status: "suggested",
      confidence: null,
      evidence: {
        basis: "retrieval",
        policyVersion: RETRIEVAL_POLICY.version,
        pageVersion: item.hit.version,
        rank: item.rank,
        mode,
        ...passageEvidence(item.hit),
      },
    });
  }
  for (const { pageId, reason } of plan.retract) {
    const current = existing.find(
      (link) => link.pageId === pageId && link.role === "context",
    );
    if (!current) continue;
    writes.push({
      pageId,
      role: "context",
      origin: "rule",
      status: "retracted",
      confidence: current.confidence,
      evidence: { ...current.evidence, retractedBecause: reason },
    });
  }
  return writes;
}

const RETRIEVAL_RECORD = (taskId: string) => `task-link:retrieval:${taskId}`;

export interface RetrievalState {
  mode: "sync" | "nightly";
  /** Fingerprint of the digest the last search used. */
  digest: string;
  /** Nightly identity: semantic fingerprint, vector and corpus state. */
  nightly?: string;
  embedding: "server" | "task" | "none";
  pages: string[];
}

export async function latestRetrievalState(
  db: Database,
  ownerId: string,
  taskId: string,
): Promise<RetrievalState | null> {
  const { rows } = await db.query<{ payload: RetrievalState }>(
    `SELECT payload FROM brain_consolidation_records
     WHERE owner_id = $1 AND kind = 'record' AND record_key = $2
     ORDER BY created_at DESC, run_id DESC LIMIT 1`,
    [ownerId, RETRIEVAL_RECORD(taskId)],
  );
  return rows[0]?.payload ?? null;
}

async function saveRetrievalState(
  db: PoolClient,
  ownerId: string,
  runId: string,
  taskId: string,
  state: RetrievalState,
) {
  await db.query(
    `INSERT INTO brain_consolidation_records (owner_id, run_id, kind, record_key, payload)
     VALUES ($1, $2, 'record', $3, $4::jsonb) ON CONFLICT DO NOTHING`,
    [ownerId, runId, RETRIEVAL_RECORD(taskId), JSON.stringify(state)],
  );
}

export function digestFingerprint(digest: string): string {
  return fingerprint({ policy: RETRIEVAL_POLICY.version, digest });
}

/** Stable identity of the indexed corpus: any page edit or reindex changes it. */
export async function corpusFingerprint(
  db: Database,
  ownerId: string,
): Promise<string> {
  const { rows } = await db.query<{ state: string | null }>(
    `SELECT md5(string_agg(id::text || ':' || version || ':' || coalesce(chunk_index_version, 0)
       || ':' || coalesce(chunk_index_model, ''), ',' ORDER BY id)) AS state
     FROM brain_pages WHERE owner_id = $1`,
    [ownerId],
  );
  return rows[0]?.state ?? "empty";
}

export interface RetrievalOutcome {
  searched: boolean;
  changes: LinkChange[];
}

async function applyRetrieval(
  ownerId: string,
  taskId: string,
  agentId: string,
  runId: string,
  results: RetrievalHit[],
  state: RetrievalState,
  expectedDigest: string,
): Promise<LinkChange[]> {
  return transaction(async (db) => {
    const task = await lockTaskForLinks(db, ownerId, taskId);
    // Content changed while searching: the next sync or night recomputes.
    if (!task || digestFingerprint(taskDigest(task)) !== expectedDigest)
      return [];
    const existing = await existingTaskLinks(db, ownerId, taskId);
    const plan = planRetrieval(
      results,
      existing,
      task.projectPageId ? [task.projectPageId] : [],
    );
    const changes = await writeMachineLinks(
      db,
      ownerId,
      taskId,
      agentId,
      retrievalWrites(plan, existing, state.mode),
    );
    await recordLinkChanges(db, ownerId, taskId, agentId, changes, {
      basis: "retrieval",
      mode: state.mode,
    });
    await saveRetrievalState(db, ownerId, runId, taskId, state);
    return changes;
  });
}

function eligible(task: LockedLinkTask | null): task is LockedLinkTask {
  return Boolean(
    task &&
      task.archivedAt === null &&
      task.status !== "done" &&
      task.status !== "canceled",
  );
}

/**
 * At creation and content edits: top results for the digest with a live query
 * embedding when available, text otherwise; recomputed only when the digest
 * changes.
 */
export async function syncTaskRetrieval(
  ownerId: string,
  taskId: string,
  agentId: string,
): Promise<RetrievalOutcome> {
  const db = getPool();
  const task = await lockTaskForLinks(db, ownerId, taskId, false);
  if (!eligible(task)) return { searched: false, changes: [] };
  const digest = taskDigest(task);
  const digestFp = digestFingerprint(digest);
  const latest = await latestRetrievalState(db, ownerId, taskId);
  if (latest?.digest === digestFp) return { searched: false, changes: [] };
  const embedding = await getQueryEmbedding(ownerId, digest);
  const { results } = await search(ownerId, {
    query: lexicalQuery(digest),
    limit: RETRIEVAL_POLICY.keep,
    expandGraph: false,
    ...(embedding
      ? {
          embedding: embedding.embedding,
          embeddingModel: embedding.embeddingModel,
        }
      : {}),
  });
  const changes = await applyRetrieval(
    ownerId,
    taskId,
    agentId,
    `task-links:sync:${randomUUID()}`,
    results,
    {
      mode: "sync",
      digest: digestFp,
      embedding: embedding ? "server" : "none",
      pages: results.map((hit) => hit.id),
    },
    digestFp,
  );
  return { searched: true, changes };
}

export interface TaskVector {
  embedding: number[];
  embeddingModel: string;
}

/**
 * Nightly, knowledge→task: repeats the search for tasks with a fresh vector or
 * a changed corpus, using the stored task vector (text and graph without one,
 * never the query key: §8.1).
 */
export async function nightlyTaskRetrieval(
  ownerId: string,
  runId: string,
  taskId: string,
  agentId: string,
  corpus: string,
  vector: (TaskVector & { fingerprint: string }) | null,
): Promise<RetrievalOutcome> {
  const db = getPool();
  const task = await lockTaskForLinks(db, ownerId, taskId, false);
  if (!eligible(task)) return { searched: false, changes: [] };
  const semantic = taskSemanticFingerprint(task);
  const current = vector?.fingerprint === semantic ? vector : null;
  const nightly = fingerprint({
    policy: RETRIEVAL_POLICY.version,
    semantic,
    vector: current?.embeddingModel ?? null,
    corpus,
  });
  const latest = await latestRetrievalState(db, ownerId, taskId);
  if (latest?.nightly === nightly) return { searched: false, changes: [] };
  const digest = taskDigest(task);
  const { results } = await search(
    ownerId,
    {
      query: lexicalQuery(digest),
      limit: RETRIEVAL_POLICY.keep,
      expandGraph: false,
      ...(current
        ? {
            embedding: current.embedding,
            embeddingModel: current.embeddingModel,
          }
        : {}),
    },
    { serverEmbedding: false },
  );
  const digestFp = digestFingerprint(digest);
  const changes = await applyRetrieval(
    ownerId,
    taskId,
    agentId,
    runId,
    results,
    {
      mode: "nightly",
      digest: digestFp,
      nightly,
      embedding: current ? "task" : "none",
      pages: results.map((hit) => hit.id),
    },
    digestFp,
  );
  return { searched: true, changes };
}
