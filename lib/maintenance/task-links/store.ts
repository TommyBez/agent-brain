import { CHUNKER_VERSION } from "../../brain/chunks";
import type { Database } from "../../brain/pages";
import { vectorLiteral } from "../../brain/utils";
import {
  type CandidateRef,
  type CompletedPass,
  type EvidencePageInput,
  pageEvidenceFingerprint,
  taskLinkKeys,
} from "./candidates";

// Reads and receipts of the nightly task linker. Nothing here writes pages,
// brain_links or revisions.

export const TASK_LINK_RECEIPT_RUN = "task-links";

export interface EvidencePage extends EvidencePageInput {
  version: number;
  fingerprint: string;
}

export async function loadEvidencePages(
  db: Database,
  ownerId: string,
  pageIds: string[],
): Promise<Map<string, EvidencePage>> {
  if (!pageIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT p.id, p.slug, p.type, p.title, p.summary, p.markdown, p.relationships,
       p.aliases, p.tags, p.version,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('targetId', l.target_id, 'type', l.type, 'label', l.label)
                 ORDER BY l.target_id, l.type)
                 FROM brain_links l WHERE l.owner_id = p.owner_id AND l.source_id = p.id), '[]'::jsonb) AS links
     FROM brain_pages p WHERE p.owner_id = $1 AND p.id = ANY($2::uuid[])`,
    [ownerId, [...new Set(pageIds)]],
  );
  return new Map(
    rows.map((row) => {
      const page: EvidencePageInput = {
        id: row.id,
        slug: row.slug,
        type: row.type,
        title: row.title,
        summary: row.summary,
        markdown: row.markdown,
        relationships: row.relationships,
        aliases: row.aliases,
        tags: row.tags,
        links: row.links,
      };
      return [
        row.id,
        {
          ...page,
          version: row.version,
          fingerprint: pageEvidenceFingerprint(page),
        },
      ];
    }),
  );
}

/** (a) decided_in decisions of the project, then 1-hop part_of/depends_on pages. */
export async function projectNeighborhood(
  db: Database,
  ownerId: string,
  projectId: string,
): Promise<CandidateRef[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (p.id) p.id, p.updated_at,
       (l.type = 'decided_in' AND l.target_id = $2 AND p.type = 'decision') AS decided_in
     FROM brain_links l
     JOIN brain_pages p ON p.owner_id = l.owner_id
       AND p.id = CASE WHEN l.source_id = $2 THEN l.target_id ELSE l.source_id END
     WHERE l.owner_id = $1 AND p.id <> $2
       AND ((l.type = 'decided_in' AND l.target_id = $2 AND p.type = 'decision')
         OR (l.type IN ('part_of', 'depends_on') AND (l.source_id = $2 OR l.target_id = $2)))
     ORDER BY p.id, decided_in DESC`,
    [ownerId, projectId],
  );
  return rows
    .sort(
      (a, b) =>
        Number(b.decided_in) - Number(a.decided_in) ||
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime() ||
        String(a.id).localeCompare(String(b.id)),
    )
    .map((row) => ({
      pageId: row.id,
      source: row.decided_in ? "decided_in" : "neighbor",
    }));
}

/** Pages a task already has an active or rejected link to, in any role. */
export async function decidedPageIds(
  db: Database,
  ownerId: string,
  taskId: string,
): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT page_id FROM brain_task_links
     WHERE owner_id = $1 AND task_id = $2 AND status IN ('active', 'rejected')`,
    [ownerId, taskId],
  );
  return rows.map((row) => row.page_id);
}

/** The passage of each page closest to the task vector, current versions only. */
export async function nearestPassages(
  db: Database,
  ownerId: string,
  pageIds: string[],
  vector: { embedding: number[]; embeddingModel: string },
): Promise<Map<string, { startOffset: number; endOffset: number }>> {
  if (!pageIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT DISTINCT ON (c.page_id) c.page_id, c.start_offset, c.end_offset
     FROM brain_page_chunks c
     JOIN brain_pages p ON p.owner_id = c.owner_id AND p.id = c.page_id
     WHERE c.owner_id = $1 AND c.page_id = ANY($2::uuid[]) AND c.page_version = p.version
       AND c.embedding_model = $4 AND c.chunker_version = $5 AND c.end_offset > c.start_offset
     ORDER BY c.page_id, c.embedding <=> $3::vector, c.start_offset`,
    [
      ownerId,
      pageIds,
      vectorLiteral(vector.embedding),
      vector.embeddingModel,
      CHUNKER_VERSION,
    ],
  );
  return new Map(
    rows.map((row) => [
      row.page_id,
      { startOffset: row.start_offset, endOffset: row.end_offset },
    ]),
  );
}

export interface StoredTaskVector {
  embedding: number[];
  embeddingModel: string;
  fingerprint: string;
}

export async function loadTaskVector(
  db: Database,
  ownerId: string,
  taskId: string,
): Promise<StoredTaskVector | null> {
  const { rows } = await db.query(
    `SELECT embedding::text AS embedding, embedding_model, semantic_fingerprint
     FROM brain_tasks WHERE owner_id = $1 AND id = $2 AND embedding IS NOT NULL`,
    [ownerId, taskId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    embedding: JSON.parse(row.embedding),
    embeddingModel: row.embedding_model,
    fingerprint: row.semantic_fingerprint,
  };
}

export async function hasReceipt(
  db: Database,
  ownerId: string,
  key: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM brain_consolidation_records
     WHERE owner_id = $1 AND run_id = $2 AND kind = 'receipt' AND record_key = $3`,
    [ownerId, TASK_LINK_RECEIPT_RUN, key],
  );
  return Boolean(rowCount);
}

export async function saveReceipt(
  db: Database,
  ownerId: string,
  key: string,
  payload: unknown,
): Promise<void> {
  await db.query(
    `INSERT INTO brain_consolidation_records (owner_id, run_id, kind, record_key, payload)
     VALUES ($1, $2, 'receipt', $3, $4::jsonb) ON CONFLICT DO NOTHING`,
    [ownerId, TASK_LINK_RECEIPT_RUN, key, JSON.stringify(payload)],
  );
}

/**
 * The inputs each task's last completed Jev pass used (one row per task),
 * stamped when they last changed.
 */
export async function loadLinkInputs(
  db: Database,
  ownerId: string,
  taskIds: string[],
): Promise<Map<string, CompletedPass>> {
  if (!taskIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT payload->>'taskId' AS task_id, payload->>'inputs' AS inputs,
       (extract(epoch FROM created_at) * 1000)::float8 AS at
     FROM brain_consolidation_records
     WHERE owner_id = $1 AND run_id = $2 AND kind = 'receipt' AND record_key = ANY($3::text[])`,
    [ownerId, TASK_LINK_RECEIPT_RUN, taskIds.map(taskLinkKeys.inputs)],
  );
  return new Map(
    rows.map((row) => [row.task_id, { inputs: row.inputs, at: row.at }]),
  );
}

export async function saveLinkInputs(
  db: Database,
  ownerId: string,
  taskId: string,
  inputs: string,
): Promise<void> {
  await db.query(
    `INSERT INTO brain_consolidation_records (owner_id, run_id, kind, record_key, payload)
     VALUES ($1, $2, 'receipt', $3, $4::jsonb)
     ON CONFLICT (owner_id, run_id, kind, record_key)
       DO UPDATE SET payload = excluded.payload, created_at = now()
       WHERE brain_consolidation_records.payload IS DISTINCT FROM excluded.payload`,
    [
      ownerId,
      TASK_LINK_RECEIPT_RUN,
      taskLinkKeys.inputs(taskId),
      JSON.stringify({ taskId, inputs }),
    ],
  );
}
