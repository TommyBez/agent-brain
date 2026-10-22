import type { Database } from "../brain/pages";
import { getPool } from "../db";
import {
  OPEN_TASKS_LIMIT,
  type OpenTaskRow,
  type OpenTasks,
  openTasksField,
} from "./open-tasks-shape";
import { authored } from "./records";
import { formatTaskRef, OPEN_TASK_STATUSES, tasksEnabled } from "./types";

// `openTasks` on read and context results of project pages (§3 rule 1, §7.3):
// a separate field marked as operational state, never part of the Markdown.

/** Open tasks of the given projects in queue order, at most 10 overall. */
export async function openTasksForProjects(
  ownerId: string,
  projectIds: string[],
  db: Database = getPool(),
): Promise<{ rows: (OpenTaskRow & { projectId: string })[]; more: boolean }> {
  if (!projectIds.length) return { rows: [], more: false };
  const { rows } = await db.query(
    `SELECT t.number, t.title, t.status, t.project_page_id, p.slug AS project_slug,
       creator.label AS creator_label, creator.kind AS creator_kind, holder.label AS holder_label
     FROM brain_tasks t
     JOIN brain_agents creator ON creator.owner_id = t.owner_id AND creator.id = t.created_by_agent_id
     LEFT JOIN brain_agents holder ON holder.owner_id = t.owner_id AND holder.id = t.claimed_by_agent_id
     JOIN brain_pages p ON p.owner_id = t.owner_id AND p.id = t.project_page_id
     WHERE t.owner_id = $1 AND t.project_page_id = ANY($2::uuid[]) AND t.archived_at IS NULL
       AND t.status = ANY($3::text[])
     ORDER BY array_position($2::uuid[], t.project_page_id), t.priority,
       COALESCE(t.due_on, (t.due_at AT TIME ZONE 'Europe/Rome')::date) NULLS LAST, t.number
     LIMIT $4`,
    [ownerId, projectIds, OPEN_TASK_STATUSES, OPEN_TASKS_LIMIT + 1],
  );
  return {
    more: rows.length > OPEN_TASKS_LIMIT,
    rows: rows.slice(0, OPEN_TASKS_LIMIT).map((row) => ({
      ref: formatTaskRef(row.number),
      title: authored(row.title as string, {
        label: row.creator_label,
        kind: row.creator_kind,
      }),
      status: row.status,
      claimedBy: row.holder_label ? { label: row.holder_label } : null,
      projectId: row.project_page_id,
      project: row.project_slug,
    })),
  };
}

export {
  OPEN_TASKS_LIMIT,
  OPEN_TASKS_NOTE,
  type OpenTaskRow,
  type OpenTasks,
} from "./open-tasks-shape";

/** `read` of a project page gains `openTasks`; other pages are unchanged. */
export async function withOpenTasks<T extends { id: string; type: string }>(
  ownerId: string,
  page: T,
): Promise<T & { openTasks?: OpenTasks }> {
  if (!tasksEnabled() || page.type !== "project") return page;
  const { rows, more } = await openTasksForProjects(ownerId, [page.id]);
  if (!rows.length) return page;
  return {
    ...page,
    openTasks: openTasksField(
      rows.map(({ projectId: _projectId, project: _project, ...row }) => row),
      more,
    ),
  };
}

/** `context` gains `openTasks` for the project pages it cites, in citation order. */
export async function contextWithOpenTasks<
  T extends { citations: { id: string }[] },
>(ownerId: string, bundle: T): Promise<T & { openTasks?: OpenTasks }> {
  if (!tasksEnabled() || !bundle.citations.length) return bundle;
  const { rows: projects } = await getPool().query(
    `SELECT id FROM brain_pages WHERE owner_id = $1 AND id = ANY($2::uuid[]) AND type = 'project'`,
    [ownerId, bundle.citations.map((citation) => citation.id)],
  );
  const ids = bundle.citations
    .map((citation) => citation.id)
    .filter((id) => projects.some((project) => project.id === id));
  if (!ids.length) return bundle;
  const { rows, more } = await openTasksForProjects(ownerId, ids);
  if (!rows.length) return bundle;
  return {
    ...bundle,
    openTasks: openTasksField(
      rows.map(({ projectId: _projectId, ...row }) => row),
      more,
    ),
  };
}
