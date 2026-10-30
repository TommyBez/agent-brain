import type { Database } from "../brain/pages";
import { taskError } from "./errors";
import type { TaskLinkOrigin, TaskLinkRole, TaskLinkStatus } from "./types";

// Task → page links that the task service writes itself: context pages named
// by the owner or an agent, the task keeper's source and verified produced
// pages. Rules and retrieval suggestions belong to the conciliator.

export interface ResolvedPage {
  ref: string;
  id: string;
  slug: string;
  title: string;
  type: string;
  version: number;
}

/** Resolves page ids or slugs; unknown references fail with their names. */
export async function resolvePages(
  db: Database,
  ownerId: string,
  refs: string[],
): Promise<ResolvedPage[]> {
  const unique = [...new Set(refs)];
  if (!unique.length) return [];
  const { rows } = await db.query(
    `SELECT id, slug, title, type, version FROM brain_pages
     WHERE owner_id = $1 AND (id::text = ANY($2::text[]) OR slug = ANY($2::text[]))`,
    [ownerId, unique],
  );
  const missing: string[] = [];
  const pages: ResolvedPage[] = [];
  for (const ref of unique) {
    const row = rows.find((page) => page.id === ref || page.slug === ref);
    if (!row) missing.push(ref);
    // An id and a slug of the same page resolve to one page.
    else if (!pages.some((page) => page.id === row.id))
      pages.push({ ref, ...row });
  }
  if (missing.length)
    throw taskError(
      "PAGE_NOT_FOUND",
      `Pages not found: ${missing.join(", ")}.`,
      "Use page ids or canonical slugs from resolve or search.",
      { refs: missing },
    );
  return pages;
}

export async function resolveProject(
  db: Database,
  ownerId: string,
  ref: string,
): Promise<ResolvedPage> {
  const { rows } = await db.query(
    `SELECT id, slug, title, type, version FROM brain_pages
     WHERE owner_id = $1 AND (id::text = $2 OR slug = $2)`,
    [ownerId, ref],
  );
  if (!rows[0] || rows[0].type !== "project")
    throw taskError(
      "PROJECT_NOT_FOUND",
      `${ref} is not a project page.`,
      "Use the id or slug of an existing page of type project (resolve with type project).",
      { ref },
    );
  return { ref, ...rows[0] };
}

const MENTION = /\/pages\/([\w/-]+)/g;

/** `/pages/<id or slug>` mentions in a description (consolidator reference syntax). */
export function mentionedPageRefs(markdown: string): string[] {
  return [
    ...new Set(
      [...markdown.matchAll(MENTION)].map((match) =>
        match[1].replace(/\/+$/, ""),
      ),
    ),
  ].slice(0, 20);
}

export async function existingPageIds(
  db: Database,
  ownerId: string,
  refs: string[],
): Promise<ResolvedPage[]> {
  if (!refs.length) return [];
  const { rows } = await db.query(
    `SELECT id, slug, title, type, version FROM brain_pages
     WHERE owner_id = $1 AND (id::text = ANY($2::text[]) OR slug = ANY($2::text[]))`,
    [ownerId, refs],
  );
  return rows.map((row) => ({ ref: row.slug, ...row }));
}

export interface LinkWrite {
  pageId: string;
  role: TaskLinkRole;
  origin: TaskLinkOrigin;
  status: TaskLinkStatus;
  evidence: Record<string, unknown>;
  confidence?: number | null;
}

/**
 * A row only the owner may rewrite: a rejection (final for task, page and
 * role), a link the owner decided, one written by the owner, a verified
 * provenance or the task keeper, and a live machine suggestion an agent
 * names again (only the owner decides suggestions).
 */
const OWNER_KEPT = `(NOT $4 AND (l.status = 'rejected' OR l.decided_at IS NOT NULL
  OR l.origin IN ('owner', 'provenance', 'task_keeper')
  OR (excluded.origin = 'agent' AND l.origin IN ('rule', 'consolidator') AND l.status <> 'retracted')))`;

/**
 * Upserts links. Rows in OWNER_KEPT change only when the owner writes them;
 * otherwise a suggestion is promoted, never demoted, by a later write.
 */
export async function upsertTaskLinks(
  db: Database,
  ownerId: string,
  taskId: string,
  actorAgentId: string,
  links: LinkWrite[],
  ownerDecides = false,
): Promise<{ pageId: string; role: string; status: string }[]> {
  // One row per (page, role): the first write wins, explicit before mentions.
  const unique = new Map<string, LinkWrite>();
  for (const link of links) {
    const key = `${link.pageId}:${link.role}`;
    if (!unique.has(key)) unique.set(key, link);
  }
  if (!unique.size) return [];
  const { rows } = await db.query(
    `INSERT INTO brain_task_links AS l (owner_id, task_id, page_id, role, origin, status, confidence, evidence, created_by_agent_id, decided_by_agent_id, decided_at)
     SELECT $1, $2, x.page_id, x.role, x.origin, x.status, x.confidence, x.evidence, $3,
       CASE WHEN $4 THEN $3::uuid END, CASE WHEN $4 THEN now() END
     FROM jsonb_to_recordset($5::jsonb) AS x(page_id uuid, role text, origin text, status text, confidence real, evidence jsonb)
     ON CONFLICT (owner_id, task_id, page_id, role) DO UPDATE SET
       status = CASE WHEN ${OWNER_KEPT} THEN l.status
         WHEN excluded.status = 'active' OR l.status = 'retracted' OR $4 THEN excluded.status
         ELSE l.status END,
       origin = CASE WHEN ${OWNER_KEPT} THEN l.origin
         WHEN excluded.status = 'active' OR $4 THEN excluded.origin ELSE l.origin END,
       evidence = CASE WHEN ${OWNER_KEPT} THEN l.evidence ELSE excluded.evidence END,
       decided_by_agent_id = CASE WHEN $4 THEN $3::uuid ELSE l.decided_by_agent_id END,
       decided_at = CASE WHEN $4 THEN now() ELSE l.decided_at END,
       updated_at = now()
     RETURNING page_id, role, status`,
    [
      ownerId,
      taskId,
      actorAgentId,
      ownerDecides,
      JSON.stringify(
        [...unique.values()].map((link) => ({
          page_id: link.pageId,
          role: link.role,
          origin: link.origin,
          status: link.status,
          confidence: link.confidence ?? null,
          evidence: link.evidence,
        })),
      ),
    ],
  );
  return rows.map((row) => ({
    pageId: row.page_id,
    role: row.role,
    status: row.status,
  }));
}

/**
 * Removes context links. Agents remove only agent links the owner has not
 * decided; the owner removes owner and agent links and rejects machine links.
 * A rejection is never deleted, so it stays final.
 */
export async function removeContextLinks(
  db: Database,
  ownerId: string,
  taskId: string,
  actorAgentId: string,
  pageIds: string[],
  byOwner: boolean,
): Promise<number> {
  if (!pageIds.length) return 0;
  const deleted = await db.query(
    `DELETE FROM brain_task_links WHERE owner_id = $1 AND task_id = $2 AND role = 'context'
       AND page_id = ANY($3::uuid[]) AND origin = ANY($4::text[]) AND status <> 'rejected'
       ${byOwner ? "" : "AND decided_at IS NULL"}`,
    [ownerId, taskId, pageIds, byOwner ? ["owner", "agent"] : ["agent"]],
  );
  let changed = deleted.rowCount ?? 0;
  if (byOwner) {
    const rejected = await db.query(
      `UPDATE brain_task_links SET status = 'rejected', decided_by_agent_id = $4, decided_at = now(), updated_at = now()
       WHERE owner_id = $1 AND task_id = $2 AND role = 'context' AND page_id = ANY($3::uuid[]) AND status <> 'rejected'`,
      [ownerId, taskId, pageIds, actorAgentId],
    );
    changed += rejected.rowCount ?? 0;
  }
  return changed;
}

export interface TaskLinkView {
  page: {
    id: string;
    slug: string;
    title: string;
    type: string;
    version: number;
  };
  role: string;
  origin: string;
  status: string;
  confidence: number | null;
  evidence: Record<string, unknown>;
  /** The cited passage, when the evidence still matches the page version. */
  passage: string | null;
}

export async function listTaskLinks(
  db: Database,
  ownerId: string,
  taskId: string,
  statuses: TaskLinkStatus[] = ["active", "suggested"],
): Promise<TaskLinkView[]> {
  const { rows } = await db.query(
    `SELECT l.page_id, l.role, l.origin, l.status, l.confidence, l.evidence,
       p.slug, p.title, p.type, p.version,
       CASE WHEN jsonb_typeof(l.evidence->'pageVersion') = 'number'
              AND (l.evidence->>'pageVersion')::int = p.version
              AND jsonb_typeof(l.evidence->'startOffset') = 'number'
              AND jsonb_typeof(l.evidence->'endOffset') = 'number'
            THEN substring(p.markdown FROM (l.evidence->>'startOffset')::int + 1
                 FOR least(600, greatest(0, (l.evidence->>'endOffset')::int - (l.evidence->>'startOffset')::int)))
       END AS passage
     FROM brain_task_links l
     JOIN brain_pages p ON p.owner_id = l.owner_id AND p.id = l.page_id
     WHERE l.owner_id = $1 AND l.task_id = $2 AND l.status = ANY($3::text[])
     ORDER BY array_position(ARRAY['active','suggested','rejected','retracted'], l.status),
       array_position(ARRAY['source','decision','context','stakeholder','produced'], l.role),
       l.confidence DESC NULLS FIRST, p.title, p.id`,
    [ownerId, taskId, statuses],
  );
  return rows.map((row) => ({
    page: {
      id: row.page_id,
      slug: row.slug,
      title: row.title,
      type: row.type,
      version: row.version,
    },
    role: row.role,
    origin: row.origin,
    status: row.status,
    confidence: row.confidence,
    evidence: row.evidence,
    passage: row.passage || null,
  }));
}
