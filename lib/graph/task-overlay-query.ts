import { assertOwner } from "../brain/utils";
import { getPool } from "../db";
import { formatTaskRef } from "../tasks/types";
import {
  EMPTY_TASK_OVERLAY,
  type OverlayLink,
  TASK_OVERLAY_LIMIT,
  TASK_OVERLAY_MAX_PAGES,
  TASK_OVERLAY_STATUSES,
  type TaskOverlay,
} from "./task-overlay";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Open tasks anchored to the given pages by an active link or their project,
 * with their active and suggested links to those pages. A separate query from
 * the page graph: it never changes which pages are loaded. Never reads the
 * lease id. Callers must authenticate the owner first.
 */
export async function loadTaskOverlay(
  ownerId: string,
  pageIds: readonly string[],
  limit = TASK_OVERLAY_LIMIT,
): Promise<TaskOverlay> {
  assertOwner(ownerId);
  const ids = [...new Set(pageIds.filter((id) => UUID.test(id)))].slice(
    0,
    TASK_OVERLAY_MAX_PAGES,
  );
  if (!ids.length) return EMPTY_TASK_OVERLAY;
  const { rows } = await getPool().query(
    `WITH anchors AS (
       SELECT l.task_id, l.page_id, l.role, l.status FROM brain_task_links l
       WHERE l.owner_id = $1 AND l.page_id = ANY($2::uuid[]) AND l.status IN ('active', 'suggested')
       UNION ALL
       SELECT t.id, t.project_page_id, 'project', 'active' FROM brain_tasks t
       WHERE t.owner_id = $1 AND t.project_page_id = ANY($2::uuid[])
     ), shown AS (
       SELECT t.id, t.number, t.title, t.status, t.priority, t.due_on, t.due_at,
         t.created_by_agent_id, t.claimed_by_agent_id, count(*) OVER ()::int AS total
       FROM brain_tasks t
       WHERE t.owner_id = $1 AND t.archived_at IS NULL AND t.status = ANY($3::text[])
         AND EXISTS (SELECT 1 FROM anchors a WHERE a.task_id = t.id AND a.status = 'active')
       ORDER BY t.priority, COALESCE(t.due_on, (t.due_at AT TIME ZONE 'Europe/Rome')::date) NULLS LAST, t.number
       LIMIT $4
     )
     SELECT s.id, s.number, s.title, s.status, s.priority, s.total,
       creator.label AS creator_label, creator.kind AS creator_kind, holder.label AS holder_label,
       (SELECT json_agg(json_build_object('pageId', a.page_id, 'role', a.role, 'status', a.status)
               ORDER BY a.page_id, a.role)
        FROM anchors a WHERE a.task_id = s.id) AS links
     FROM shown s
     JOIN brain_agents creator ON creator.owner_id = $1 AND creator.id = s.created_by_agent_id
     LEFT JOIN brain_agents holder ON holder.owner_id = $1 AND holder.id = s.claimed_by_agent_id
     ORDER BY s.priority, COALESCE(s.due_on, (s.due_at AT TIME ZONE 'Europe/Rome')::date) NULLS LAST, s.number`,
    [ownerId, ids, TASK_OVERLAY_STATUSES, limit],
  );
  return {
    tasks: rows.map((row) => ({
      id: row.id,
      ref: formatTaskRef(row.number),
      title: row.title,
      authoredBy: row.creator_label,
      untrusted: row.creator_kind !== "owner",
      status: row.status,
      priority: row.priority,
      claimedBy: row.holder_label,
    })),
    links: rows.flatMap((row) =>
      (row.links as Omit<OverlayLink, "taskId">[]).map((link) => ({
        taskId: row.id,
        ...link,
      })),
    ),
    total: rows[0]?.total ?? 0,
  };
}
