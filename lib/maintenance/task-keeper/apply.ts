import { EMBEDDING_DIMENSIONS, embeddingSchema } from "../../brain/schemas";
import { resolve } from "../../brain/search";
import { BrainError } from "../../brain/types";
import { embeddingModel } from "../../brain/utils";
import { fingerprint } from "../../canonical-json";
import { getPool } from "../../db";
import type { Actor } from "../../tasks/actors";
import { addTaskParty } from "../../tasks/parties";
import { sanitizeTaskLine } from "../../tasks/sanitize";
import { createTask } from "../../tasks/service";
import { TASK_LIMITS, taskBatchId } from "../../tasks/types";
import type { Evaluate } from "../consolidator/types";
import { type GatewayCall, gatewayRequest } from "../gateway";
import {
  type DuplicateCandidate,
  extractionFingerprint,
  judgeDuplicate,
  normalizeForFingerprint,
  passageIdentity,
} from "./dedupe";
import type { ExtractedItem } from "./extract";
import { TASK_KEEPER_LIMITS, TASK_KEEPER_THRESHOLDS } from "./policy";
import { type Excerpt, excerptOf, type KeeperSnapshot } from "./snapshot";
import { keeperKeys, openSuggestion } from "./store";
import { type VerifiedItem, verifyItem } from "./verify";

// Steps 5 and 6: dedupe against open and closed tasks and remembered
// rejections, then create in triage through the task service. The keeper
// never writes pages, brain_links or revisions, and never transitions tasks.

export type SettleOutcome =
  | "created"
  | "existing"
  | "new_source"
  | "rejected"
  | "not_commitment"
  | "already_done"
  | "missing";

export interface SettleResult {
  outcome: SettleOutcome;
  taskRef?: string;
  /** new_source: whether a suggestion was opened (dedupe and the 3-per-task cap). */
  opened?: boolean;
  /** new_source refused only by the 3-per-task cap: the page stays pending. */
  capped?: boolean;
  dropped?: string[];
  parties?: number;
  /** The task holding this extraction, for its passage identity records. */
  identity?: { extraction: string; passages: string[] };
}

export type QueryEmbedding = (
  text: string,
) => Promise<{ embedding: number[]; embeddingModel: string } | null>;

export interface SettleDeps {
  actor: Actor;
  evaluate: Evaluate;
  /** Item vector for embedding candidates; null skips them. */
  embed?: QueryEmbedding;
}

function line(value: string, max: number): string {
  const clean = sanitizeTaskLine(value);
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

async function knownExtraction(ownerId: string, fp: string) {
  const { rows } = await getPool().query(
    `SELECT EXISTS (SELECT 1 FROM brain_task_extraction_rejections WHERE owner_id = $1 AND fingerprint = $2) AS rejected,
       t.number, t.batch_id
     FROM (SELECT 1) one
     LEFT JOIN brain_tasks t ON t.owner_id = $1 AND t.extraction_fingerprint = $2`,
    [ownerId, fp],
  );
  return {
    rejected: rows[0].rejected as boolean,
    number: (rows[0].number as number | null) ?? null,
    batchId: (rows[0].batch_id as string | null) ?? null,
  };
}

/**
 * Whether passages cited by this item belong to a rejected extraction and to
 * no live one: the same source text under a reworded title. A passage shared
 * with a live extraction (two commitments in one line) is left to the
 * duplicate judgment.
 */
async function passagesRejected(
  ownerId: string,
  passages: string[],
): Promise<boolean> {
  if (!passages.length) return false;
  const { rows } = await getPool().query(
    `WITH identities AS (
       SELECT DISTINCT split_part(record_key, ':', 4) AS fingerprint
       FROM brain_consolidation_records
       WHERE owner_id = $1 AND kind = 'record' AND record_key LIKE ANY($2::text[])
     )
     SELECT count(r.fingerprint)::int AS rejected,
       count(t.id) FILTER (WHERE r.fingerprint IS NULL)::int AS live
     FROM identities i
     LEFT JOIN brain_task_extraction_rejections r ON r.owner_id = $1 AND r.fingerprint = i.fingerprint
     LEFT JOIN brain_tasks t ON t.owner_id = $1 AND t.extraction_fingerprint = i.fingerprint`,
    [
      ownerId,
      passages.map((passage) => `${keeperKeys.identity(passage, "")}%`),
    ],
  );
  return rows[0].rejected > 0 && rows[0].live === 0;
}

/**
 * pg_trgm and (when vectors exist) embedding candidates, open and closed;
 * archived tasks only when their extraction was rejected.
 */
export async function findDuplicateCandidates(
  ownerId: string,
  sourcePageId: string,
  title: string,
  vector: { embedding: number[]; embeddingModel: string } | null,
): Promise<DuplicateCandidate[]> {
  const { rows } = await getPool().query(
    `WITH scored AS (
       SELECT t.id, t.number, t.title, t.description, t.acceptance_criteria, t.status, t.extraction_fingerprint,
         similarity(t.title, $2) AS similarity,
         CASE WHEN $3::text IS NOT NULL AND t.embedding IS NOT NULL AND t.embedding_model = $4
           THEN t.embedding <=> $3::vector END AS distance
       FROM brain_tasks t WHERE t.owner_id = $1
         AND (t.archived_at IS NULL OR (t.extraction_fingerprint IS NOT NULL AND EXISTS (
           SELECT 1 FROM brain_task_extraction_rejections r
           WHERE r.owner_id = t.owner_id AND r.fingerprint = t.extraction_fingerprint)))
     )
     SELECT s.id, s.number, s.title, s.description, s.acceptance_criteria, s.status,
       (s.extraction_fingerprint IS NOT NULL AND EXISTS (
          SELECT 1 FROM brain_task_extraction_rejections r
          WHERE r.owner_id = $1 AND r.fingerprint = s.extraction_fingerprint)) AS rejected,
       EXISTS (SELECT 1 FROM brain_task_links l
          WHERE l.owner_id = $1 AND l.task_id = s.id AND l.page_id = $5
            AND l.role = 'source' AND l.status = 'active') AS same_source
     FROM scored s
     WHERE s.similarity >= $6 OR s.distance < $7
     ORDER BY greatest(s.similarity, 1 - coalesce(s.distance, 1)) DESC, s.number
     LIMIT $8`,
    [
      ownerId,
      title,
      vector ? JSON.stringify(vector.embedding) : null,
      vector?.embeddingModel ?? null,
      sourcePageId,
      TASK_KEEPER_THRESHOLDS.extractionCandidateSimilarity,
      TASK_KEEPER_THRESHOLDS.extractionCandidateDistance,
      TASK_KEEPER_LIMITS.candidatesPerItem,
    ],
  );
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptance_criteria,
    status: row.status,
    rejected: row.rejected,
    sameSource: row.same_source,
  }));
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((value) => `> ${value}`.trimEnd())
    .join("\n");
}

export function extractedDescription(
  snapshot: KeeperSnapshot,
  excerpt: Excerpt,
): string {
  const body = quote(excerpt.text.slice(0, 4000));
  return `${body}\n\nSource: [${snapshot.page.title.replace(/[[\]]/g, "")}](/pages/${snapshot.page.id}) · version ${snapshot.page.version}`;
}

export function dueInput(item: VerifiedItem, excerpt: Excerpt) {
  if (item.dueKind === "unset") return undefined;
  const sourceExcerpt = line(excerpt.text, 500);
  if (item.dueKind === "date")
    return {
      kind: "date" as const,
      on: item.dueDate as string,
      ...(item.dueText ? { text: item.dueText } : {}),
      sourceExcerpt,
    };
  return {
    kind: item.dueKind,
    text: item.dueText as string,
    sourceExcerpt,
  };
}

export type PartyMember =
  | { kind: "owner" }
  | { kind: "person"; personPageRef: string }
  | { kind: "group"; groupLabel: string };

function wordsOf(value: string): string[] {
  return normalizeForFingerprint(value).split(" ").filter(Boolean);
}

/**
 * An exact, unambiguous identity match, or a single linked person page whose
 * title or alias contains the name's words; otherwise the name stays a group
 * label. Never an invented page.
 */
export async function resolveParty(
  ownerId: string,
  name: string,
  snapshot: KeeperSnapshot,
  ownerPersonPageId: string | null,
): Promise<PartyMember> {
  let pageId: string | null = null;
  try {
    const result = await resolve(ownerId, {
      name: name.slice(0, 200),
      type: "person",
      limit: 8,
    });
    pageId = result.match?.id ?? null;
  } catch {
    pageId = null;
  }
  if (!pageId) {
    const words = wordsOf(name);
    const matches = snapshot.linked.filter(
      (page) =>
        page.type === "person" &&
        words.length > 0 &&
        [page.title, ...page.aliases].some((label) => {
          const labelWords = wordsOf(label);
          return words.every((word) => labelWords.includes(word));
        }),
    );
    if (matches.length === 1) pageId = matches[0].id;
  }
  if (pageId && pageId === ownerPersonPageId) return { kind: "owner" };
  if (pageId) return { kind: "person", personPageRef: pageId };
  return {
    kind: "group",
    groupLabel: line(name, TASK_LIMITS.partyGroupLabel),
  };
}

async function ownerPersonPage(ownerId: string): Promise<string | null> {
  const { rows } = await getPool().query(
    "SELECT person_page_id FROM brain_agents WHERE owner_id = $1 AND kind = 'owner'",
    [ownerId],
  );
  return rows[0]?.person_page_id ?? null;
}

async function createExtracted(
  deps: SettleDeps,
  snapshot: KeeperSnapshot,
  item: VerifiedItem,
  excerpt: Excerpt,
  extraction: string,
  projectId: string | null,
) {
  return createTask(deps.actor, {
    origin: "extracted",
    title: item.title,
    description: extractedDescription(snapshot, excerpt),
    ...(projectId ? { projectRef: projectId } : {}),
    ...(dueInput(item, excerpt) ? { due: dueInput(item, excerpt) } : {}),
    sourcePageRef: snapshot.page.id,
    sourceVersion: snapshot.page.version,
    sourceExcerpt: {
      startOffset: excerpt.startOffset,
      endOffset: excerpt.endOffset,
    },
    batchId: taskBatchId(snapshot.page.id, snapshot.page.version),
    extractionFingerprint: extraction,
  });
}

function code(error: unknown): string | null {
  return error instanceof BrainError ? error.code : null;
}

/** One extracted item, from fingerprint checks to a triage task or new_source. */
export async function settleItem(
  snapshot: KeeperSnapshot,
  item: ExtractedItem,
  deps: SettleDeps,
): Promise<SettleResult> {
  const ownerId = deps.actor.ownerId;
  const excerpt = excerptOf(snapshot, item.passages);
  const texts = item.passages.map((index) => snapshot.units[index].text);
  const extraction = extractionFingerprint(snapshot.page.id, texts, item.title);
  const identity = {
    extraction,
    passages: texts.map((text) => passageIdentity(snapshot.page.id, text)),
  };
  const known = await knownExtraction(ownerId, extraction);
  if (known.rejected) return { outcome: "rejected" };
  const batchId = taskBatchId(snapshot.page.id, snapshot.page.version);
  // Transcribed from an earlier version of the page: never touched again.
  if (known.number !== null && known.batchId !== batchId)
    return { outcome: "existing", taskRef: `T-${known.number}`, identity };
  // A rejected extraction read again with a reworded title.
  if (
    known.number === null &&
    (await passagesRejected(ownerId, identity.passages))
  )
    return { outcome: "rejected" };

  const verification = await verifyItem(snapshot, item, deps.evaluate);
  if (verification.status !== "accepted")
    return { outcome: verification.status };
  const verified = verification.item;
  // Same batch (a replayed step or a run cut by the cap): finish its parties.
  if (known.number !== null) {
    const ref = `T-${known.number}`;
    return {
      outcome: "existing",
      taskRef: ref,
      dropped: verification.dropped,
      parties: await addParties(deps, snapshot, verified, ref),
      identity,
    };
  }

  const vector = deps.embed
    ? await deps
        .embed(`${verified.title}\n\n${excerpt.text}`.slice(0, 1000))
        .catch(() => null)
    : null;
  const candidates = await findDuplicateCandidates(
    ownerId,
    snapshot.page.id,
    verified.title,
    vector,
  );
  const duplicate = await judgeDuplicate(
    verified,
    excerpt,
    candidates,
    deps.evaluate,
  );
  if (duplicate.outcome === "rejected" || duplicate.outcome === "existing")
    return {
      outcome: duplicate.outcome,
      taskRef: `T-${duplicate.candidate.number}`,
      dropped: verification.dropped,
    };
  if (duplicate.outcome === "new_source") {
    const due = dueInput(verified, excerpt);
    const suggestion = await openSuggestion(getPool(), {
      ownerId,
      taskId: duplicate.candidate.id,
      kind: "new_source",
      citations: [
        {
          pageId: snapshot.page.id,
          slug: snapshot.page.slug,
          title: snapshot.page.title,
          pageVersion: snapshot.page.version,
          startOffset: excerpt.startOffset,
          endOffset: excerpt.endOffset,
          excerpt: excerpt.text.slice(0, 1000),
        },
      ],
      confidence: duplicate.probability,
      dedupeKey: `new_source:${duplicate.candidate.id}:${snapshot.page.id}:${fingerprint(normalizeForFingerprint(excerpt.text)).slice(0, 16)}`,
      payload: {
        action: "link",
        role: "source",
        pageId: snapshot.page.id,
        pageVersion: snapshot.page.version,
        startOffset: excerpt.startOffset,
        endOffset: excerpt.endOffset,
        title: verified.title,
        actorNames: verified.actorNames,
        ...(due ? { due } : {}),
      },
      createdByAgentId: deps.actor.agentId,
    });
    return {
      outcome: "new_source",
      taskRef: `T-${duplicate.candidate.number}`,
      opened: suggestion === "opened",
      capped: suggestion === "capped",
      dropped: verification.dropped,
    };
  }

  let created: Awaited<ReturnType<typeof createTask>>;
  try {
    try {
      created = await createExtracted(
        deps,
        snapshot,
        verified,
        excerpt,
        extraction,
        verified.projectId,
      );
    } catch (error) {
      // The page stopped being a project: keep the task, drop the project.
      if (code(error) !== "PROJECT_NOT_FOUND" || !verified.projectId)
        throw error;
      created = await createExtracted(
        deps,
        snapshot,
        verified,
        excerpt,
        extraction,
        null,
      );
    }
  } catch (error) {
    if (code(error) === "EXTRACTION_REJECTED") return { outcome: "rejected" };
    if (code(error) === "PAGE_NOT_FOUND") return { outcome: "missing" };
    throw error;
  }
  const ref = created.task.ref;
  return {
    outcome: created.replayed ? "existing" : "created",
    taskRef: ref,
    dropped: verification.dropped,
    parties: await addParties(deps, snapshot, verified, ref),
    identity,
  };
}

/** Leads from the verified actor names; idempotent per role and member. */
async function addParties(
  deps: SettleDeps,
  snapshot: KeeperSnapshot,
  item: VerifiedItem,
  ref: string,
): Promise<number> {
  if (!item.actorNames.length) return 0;
  const ownerId = deps.actor.ownerId;
  const ownerPage = await ownerPersonPage(ownerId);
  const sourceNote = line(
    `${snapshot.page.title} (v${snapshot.page.version})`,
    TASK_LIMITS.partySourceNote,
  );
  let parties = 0;
  for (const name of item.actorNames) {
    const member = await resolveParty(ownerId, name, snapshot, ownerPage);
    try {
      await addTaskParty(deps.actor, ref, {
        role: "lead",
        ...member,
        sourceNote,
      });
    } catch (error) {
      // A person page deleted meanwhile: keep the name as text.
      if (!(error instanceof BrainError) || member.kind === "group")
        throw error;
      await addTaskParty(deps.actor, ref, {
        role: "lead",
        kind: "group",
        groupLabel: line(name, TASK_LIMITS.partyGroupLabel),
        sourceNote,
      });
    }
    parties++;
  }
  return parties;
}

/**
 * Item vectors through the maintenance gateway, like task vectors (§8.1:
 * never the query key). Null on any failure: dedupe keeps pg_trgm.
 */
export const maintenanceEmbedding =
  (send: GatewayCall = gatewayRequest): QueryEmbedding =>
  async (text) => {
    const model = embeddingModel();
    try {
      const response = await send<{ data?: { embedding?: unknown }[] }>(
        "embeddings",
        { model, input: text, dimensions: EMBEDDING_DIMENSIONS },
      );
      const embedding = embeddingSchema.parse(response?.data?.[0]?.embedding);
      return { embedding, embeddingModel: model };
    } catch (error) {
      console.error("task_keeper.embedding_error", {
        error: error instanceof Error ? error.name : "unknown error",
      });
      return null;
    }
  };
