import type { QueryResultRow } from "pg";
import { escapeLike } from "@/lib/brain/pages";
import { assertOwner } from "@/lib/brain/utils";
import { getPool } from "@/lib/db";
import { listAgents } from "@/lib/tasks/actors";
import { recentEvents } from "@/lib/tasks/events";
import { listTaskLinks } from "@/lib/tasks/page-links";
import { listTaskParties } from "@/lib/tasks/parties";
import {
  authored,
  iso,
  loadTaskRow,
  TASK_VIEW_SELECT,
  taskListRow,
  taskView,
} from "@/lib/tasks/records";
import { getTaskSettings } from "@/lib/tasks/settings";
import {
  formatTaskRef,
  OPEN_TASK_STATUSES,
  parseTaskBatchId,
  parseTaskRef,
  type TaskStatus,
} from "@/lib/tasks/types";
import {
  TASK_TABLE_PAGE_SIZE,
  type TaskBoardFilters,
  type TaskListFilters,
  type TaskSort,
} from "./task-urls";

// Owner-scoped reads behind the task views. Plain functions of the owner id,
// so database tests can run them; lib/workspace/tasks-data.ts authorizes the
// session and caches them for the app.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUESTION_STALE_DAYS = 7;

/** A list row: the list_tasks shape plus what the owner's views show. */
function taskRow(row: QueryResultRow) {
  return {
    ...taskListRow(row),
    number: row.number as number,
    origin: row.origin as string,
    createdBy: {
      id: row.created_by_agent_id as string,
      label: row.creator_label as string,
      kind: row.creator_kind as string,
    },
    createdAt: iso(row.created_at) as string,
    claimedAt: iso(row.claimed_at),
    /** Claims taken so far; the owner's actions send it back as a fence. */
    claimCount: row.claim_count as number,
    inputRequestedAt: iso(row.input_requested_at),
    completedAt: iso(row.completed_at),
    batchId: row.batch_id as string | null,
    requiresHuman: row.requires_human as boolean,
    archived: row.archived_at !== null,
  };
}
export type TaskRow = ReturnType<typeof taskRow>;

const ORDER: Record<TaskSort, (direction: "ASC" | "DESC") => string> = {
  priority: (d) =>
    `v.priority ${d}, (v.due_key = 'infinity'), v.due_key, v.number`,
  due: (d) => `(v.due_key = 'infinity'), v.due_key ${d}, v.priority, v.number`,
  updated: (d) => `v.updated_at ${d}, v.number DESC`,
  created: (d) => `v.created_at ${d}, v.number DESC`,
  number: (d) => `v.number ${d}`,
};

/** Full text, a substring of title or description, or the T-n reference itself. */
function textMatch(add: (value: unknown) => string, query: string): string {
  const like = add(`%${escapeLike(query)}%`);
  const conditions = [
    `t.search_document @@ websearch_to_tsquery('simple', ${add(query)})`,
    `t.title ILIKE ${like}`,
    `t.description ILIKE ${like}`,
  ];
  const ref = parseTaskRef(query);
  if (ref?.kind === "number") conditions.push(`t.number = ${add(ref.number)}`);
  return `(${conditions.join(" OR ")})`;
}

function builder(ownerId: string) {
  const params: unknown[] = [ownerId];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  return { params, add };
}

/** The filtered table of /tasks: open tasks unless statuses say otherwise. */
export async function queryTaskTable(
  ownerId: string,
  filters: TaskListFilters,
) {
  assertOwner(ownerId);
  const { params, add } = builder(ownerId);
  const where = [
    "t.owner_id = $1",
    filters.archived ? "t.archived_at IS NOT NULL" : "t.archived_at IS NULL",
  ];
  const statuses: readonly string[] = filters.statuses.length
    ? filters.statuses
    : filters.archived
      ? []
      : OPEN_TASK_STATUSES;
  if (statuses.length) where.push(`t.status = ANY(${add(statuses)}::text[])`);
  if (filters.query) where.push(textMatch(add, filters.query));
  if (filters.projectId && UUID.test(filters.projectId))
    where.push(`t.project_page_id = ${add(filters.projectId)}::uuid`);
  if (filters.priorities.length)
    where.push(`t.priority = ANY(${add(filters.priorities)}::smallint[])`);
  if (filters.agentId && UUID.test(filters.agentId)) {
    const agent = add(filters.agentId);
    where.push(
      `(t.claimed_by_agent_id = ${agent}::uuid OR t.delegate_agent_id = ${agent}::uuid OR t.created_by_agent_id = ${agent}::uuid)`,
    );
  }
  const direction = filters.direction === "desc" ? "DESC" : "ASC";
  const limit = add(TASK_TABLE_PAGE_SIZE + 1);
  const offset = add(filters.offset);
  const sql = `SELECT v.*, count(*) OVER ()::int AS total_count
    FROM (${TASK_VIEW_SELECT} WHERE ${where.join(" AND ")}) v
    ORDER BY ${ORDER[filters.sort](direction)}
    LIMIT ${limit} OFFSET ${offset}`;
  const db = getPool();
  const { rows } = await db.query(sql, params);
  let total = rows[0]?.total_count ?? 0;
  if (!rows.length && filters.offset > 0) {
    const counted = await db.query(
      `SELECT count(*)::int AS total FROM (${TASK_VIEW_SELECT} WHERE ${where.join(" AND ")}) v`,
      params.slice(0, params.length - 2),
    );
    total = counted.rows[0].total;
  }
  return {
    rows: rows.slice(0, TASK_TABLE_PAGE_SIZE).map(taskRow),
    total: total as number,
    hasMore: rows.length > TASK_TABLE_PAGE_SIZE,
  };
}

const SECTION_LIMIT = 50;

async function sectionRows(ownerId: string, condition: string) {
  const { rows } = await getPool().query(
    `SELECT v.*, count(*) OVER ()::int AS total_count
     FROM (${TASK_VIEW_SELECT} WHERE t.owner_id = $1 AND t.archived_at IS NULL AND ${condition}) v
     ORDER BY ${ORDER.priority("ASC")} LIMIT ${SECTION_LIMIT}`,
    [ownerId],
  );
  return {
    rows: rows.map(taskRow),
    total: (rows[0]?.total_count ?? 0) as number,
  };
}

/** The open sections under Needs you; triage and reviews live in Needs you. */
export async function queryTaskOverview(ownerId: string) {
  assertOwner(ownerId);
  const [inProgress, ready, waiting] = await Promise.all([
    sectionRows(ownerId, "t.status IN ('in_progress','needs_input')"),
    sectionRows(ownerId, "t.status = 'ready' AND t.approved_at IS NOT NULL"),
    sectionRows(ownerId, "t.status IN ('blocked','on_hold')"),
  ]);
  return { inProgress, ready, waiting };
}

interface SourceView {
  page: { id: string; slug: string; title: string; type: string };
  version: number | null;
  passage: string | null;
}

/** The cited source of each task: page, version and the passage at that version. */
async function sourcesOf(
  ownerId: string,
  taskIds: string[],
): Promise<Map<string, SourceView>> {
  if (!taskIds.length) return new Map();
  const { rows } = await getPool().query(
    `SELECT DISTINCT ON (l.task_id) l.task_id, p.id, p.slug, p.title, p.type, ev.version,
       CASE WHEN jsonb_typeof(l.evidence->'startOffset') = 'number' AND jsonb_typeof(l.evidence->'endOffset') = 'number'
         THEN substring(
           COALESCE(CASE WHEN ev.version = p.version THEN p.markdown END, r.snapshot->>'markdown')
           FROM floor((l.evidence->>'startOffset')::numeric)::int + 1
           FOR least(600, greatest(0, floor((l.evidence->>'endOffset')::numeric)::int - floor((l.evidence->>'startOffset')::numeric)::int)))
       END AS passage
     FROM brain_task_links l
     JOIN brain_pages p ON p.owner_id = l.owner_id AND p.id = l.page_id
     CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(l.evidence->'pageVersion') = 'number'
       THEN floor((l.evidence->>'pageVersion')::numeric)::int END AS version) ev
     LEFT JOIN brain_revisions r ON r.owner_id = l.owner_id AND r.page_id = l.page_id AND r.version = ev.version
     WHERE l.owner_id = $1 AND l.task_id = ANY($2::uuid[]) AND l.role = 'source' AND l.status = 'active'
     ORDER BY l.task_id, l.created_at, p.id`,
    [ownerId, taskIds],
  );
  return new Map(
    rows.map((row) => [
      row.task_id as string,
      {
        page: { id: row.id, slug: row.slug, title: row.title, type: row.type },
        version: row.version as number | null,
        passage: (row.passage as string | null) || null,
      },
    ]),
  );
}

async function pageTitles(ownerId: string, ids: string[]) {
  const unique = [...new Set(ids.filter((id) => UUID.test(id)))];
  if (!unique.length) return new Map<string, QueryResultRow>();
  const { rows } = await getPool().query(
    "SELECT id, slug, title, type, version FROM brain_pages WHERE owner_id = $1 AND id = ANY($2::uuid[])",
    [ownerId, unique],
  );
  return new Map(rows.map((row) => [row.id as string, row]));
}

async function latestEvents(
  ownerId: string,
  taskIds: string[],
  action: "asked" | "claimed",
) {
  if (!taskIds.length) return new Map<string, QueryResultRow>();
  const { rows } = await getPool().query(
    `SELECT DISTINCT ON (e.task_id) e.task_id, e.note, e.payload, e.created_at, a.label AS actor_label
     FROM brain_task_events e
     JOIN brain_agents a ON a.owner_id = e.owner_id AND a.id = e.actor_agent_id
     WHERE e.owner_id = $1 AND e.task_id = ANY($2::uuid[]) AND e.action = $3
     ORDER BY e.task_id, e.id DESC`,
    [ownerId, taskIds, action],
  );
  return new Map(rows.map((row) => [row.task_id as string, row]));
}

const choicesOf = (payload: unknown): string[] => {
  const choices = (payload as { choices?: unknown } | null)?.choices;
  return Array.isArray(choices)
    ? choices.filter((choice): choice is string => typeof choice === "string")
    : [];
};

export interface TriageBatch {
  key: string;
  batchId: string | null;
  source: { id: string; slug: string; title: string; version: number } | null;
  createdBy: { id: string; label: string; kind: string };
  tasks: (TaskRow & { source: SourceView | null })[];
}

export interface CitationView {
  pageId: string | null;
  title: string | null;
  slug: string | null;
  version: number | null;
  excerpt: string | null;
}

function citationViews(
  citations: unknown,
  pages: Map<string, QueryResultRow>,
): CitationView[] {
  if (!Array.isArray(citations)) return [];
  return citations.slice(0, 10).flatMap((citation) => {
    if (!citation || typeof citation !== "object") return [];
    const item = citation as Record<string, unknown>;
    const id = [item.pageId, item.pageRef, item.page].find(
      (value): value is string => typeof value === "string",
    );
    const page = id ? pages.get(id) : undefined;
    const excerpt = [item.excerpt, item.quote, item.text, item.passage].find(
      (value): value is string => typeof value === "string",
    );
    const version = [item.version, item.pageVersion].find(
      (value): value is number => typeof value === "number",
    );
    if (!page && !excerpt) return [];
    return [
      {
        pageId: page ? (page.id as string) : null,
        title: page ? (page.title as string) : null,
        slug: page ? (page.slug as string) : null,
        version: version ?? null,
        excerpt: excerpt ? excerpt.slice(0, 600) : null,
      },
    ];
  });
}

function citedPageIds(citations: unknown): string[] {
  if (!Array.isArray(citations)) return [];
  return citations.flatMap((citation) => {
    const item = (citation ?? {}) as Record<string, unknown>;
    return [item.pageId, item.pageRef, item.page].filter(
      (value): value is string => typeof value === "string",
    );
  });
}

/** Open task keeper suggestions, optionally for one task. */
export async function querySuggestions(ownerId: string, taskId?: string) {
  assertOwner(ownerId);
  const params: unknown[] = [ownerId];
  if (taskId) params.push(taskId);
  const { rows } = await getPool().query(
    `SELECT s.id, s.kind, s.citations, s.confidence, s.payload, s.created_at,
       t.id AS task_id, t.number, t.title, t.status, t.version, t.claim_count, t.approved_at,
       creator.label AS creator_label, creator.kind AS creator_kind,
       author.label AS author_label, related.number AS related_number
     FROM brain_task_suggestions s
     JOIN brain_tasks t ON t.owner_id = s.owner_id AND t.id = s.task_id
     JOIN brain_agents creator ON creator.owner_id = t.owner_id AND creator.id = t.created_by_agent_id
     JOIN brain_agents author ON author.owner_id = s.owner_id AND author.id = s.created_by_agent_id
     LEFT JOIN brain_tasks related ON related.owner_id = s.owner_id AND related.id = s.related_task_id
     WHERE s.owner_id = $1 AND s.status = 'open' AND t.archived_at IS NULL ${taskId ? "AND s.task_id = $2" : ""}
     ORDER BY s.created_at DESC, s.id LIMIT 100`,
    params,
  );
  const pages = await pageTitles(
    ownerId,
    rows.flatMap((row) => citedPageIds(row.citations)),
  );
  return rows.map((row) => ({
    id: row.id as string,
    kind: row.kind as string,
    confidence: row.confidence as number | null,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    rawCitations: row.citations as unknown,
    citations: citationViews(row.citations, pages),
    createdAt: iso(row.created_at) as string,
    suggestedBy: row.author_label as string,
    task: {
      id: row.task_id as string,
      ref: formatTaskRef(row.number),
      title: authored(row.title as string, {
        label: row.creator_label,
        kind: row.creator_kind,
      }),
      status: row.status as string,
      version: row.version as number,
      claimCount: row.claim_count as number,
      approved: row.approved_at !== null,
    },
    relatedRef: row.related_number ? formatTaskRef(row.related_number) : null,
  }));
}
export type SuggestionView = Awaited<
  ReturnType<typeof querySuggestions>
>[number];

/**
 * The committed state an owner action is checked against (never cached):
 * status and version, plus the claim and the question the screen showed.
 */
export async function queryTaskState(ownerId: string, ref: string) {
  assertOwner(ownerId);
  const row = await loadTaskRow(getPool(), ownerId, ref);
  return {
    ref: formatTaskRef(row.number),
    status: row.status as TaskStatus,
    approved: row.approved_at !== null,
    version: row.version as number,
    claimCount: row.claim_count as number,
    holder: (row.holder_label as string | null) ?? null,
    inputRequestedAt: iso(row.input_requested_at),
  };
}
export type TaskState = Awaited<ReturnType<typeof queryTaskState>>;

/** One open suggestion, as the accept action needs it. */
export async function querySuggestion(ownerId: string, id: string) {
  assertOwner(ownerId);
  if (!UUID.test(id)) return null;
  const { rows } = await getPool().query(
    `SELECT s.id, s.kind, s.payload, s.citations, s.task_id, t.number
     FROM brain_task_suggestions s
     JOIN brain_tasks t ON t.owner_id = s.owner_id AND t.id = s.task_id
     WHERE s.owner_id = $1 AND s.id = $2 AND s.status = 'open'`,
    [ownerId, id],
  );
  return rows[0]
    ? {
        id: rows[0].id as string,
        kind: rows[0].kind as string,
        payload: rows[0].payload as unknown,
        citations: rows[0].citations as unknown,
        taskId: rows[0].task_id as string,
        ref: formatTaskRef(rows[0].number),
      }
    : null;
}

/** Whether an agent can still be made a task's delegate. */
export async function queryActiveAgent(ownerId: string, agentId: string) {
  assertOwner(ownerId);
  if (!UUID.test(agentId)) return false;
  const { rowCount } = await getPool().query(
    "SELECT 1 FROM brain_agents WHERE owner_id = $1 AND id = $2 AND kind = 'agent' AND disabled_at IS NULL",
    [ownerId, agentId],
  );
  return Boolean(rowCount);
}

/** Rows per Needs you section; each section reports its full count. */
export const NEEDS_YOU_SECTION_LIMIT = 100;

const NEEDS_YOU_SECTIONS = [
  "triage",
  "questions",
  "staleQuestions",
  "reviews",
  "humanSteps",
] as const;
type NeedsYouSection = (typeof NEEDS_YOU_SECTIONS)[number];

/**
 * Everything waiting for the owner: triage by source, questions (stale after
 * 7 days), reviews, human steps, claims taken on the owner's request and
 * task keeper suggestions. Each section keeps its first rows in priority
 * order and its total, so a long section never hides another one.
 */
export async function queryNeedsYou(ownerId: string) {
  assertOwner(ownerId);
  const db = getPool();
  const [sectioned, requested, suggestionCount] = await Promise.all([
    db.query(
      `SELECT v.* FROM (
         SELECT v.*, row_number() OVER (PARTITION BY v.section ORDER BY v.priority, v.due_key, v.number) AS section_rank,
           count(*) OVER (PARTITION BY v.section)::int AS section_total
         FROM (
           SELECT v.*, CASE
               WHEN v.status = 'needs_input' AND v.input_requested_at < now() - make_interval(days => $2) THEN 'staleQuestions'
               WHEN v.status = 'needs_input' THEN 'questions'
               WHEN v.status = 'in_review' THEN 'reviews'
               WHEN v.status = 'blocked' THEN 'humanSteps'
               ELSE 'triage' END AS section
           FROM (${TASK_VIEW_SELECT}
             WHERE t.owner_id = $1 AND t.archived_at IS NULL AND (
               t.status IN ('triage','needs_input','in_review')
               OR (t.status = 'ready' AND t.approved_at IS NULL)
               OR (t.status = 'blocked' AND t.blocked_reason = 'human_step'))) v
         ) v
       ) v
       WHERE v.section_rank <= $3
       ORDER BY v.priority, v.due_key, v.number`,
      [ownerId, QUESTION_STALE_DAYS, NEEDS_YOU_SECTION_LIMIT],
    ),
    // Claims on request are found from their claim event, not by loading
    // every task in progress.
    db.query(
      `SELECT v.*, count(*) OVER ()::int AS total_count FROM (${TASK_VIEW_SELECT}
         WHERE t.owner_id = $1 AND t.archived_at IS NULL
           AND t.status IN ('in_progress','needs_input') AND t.claimed_by_agent_id IS NOT NULL
           AND (SELECT jsonb_typeof(e.payload #> '{ownerRequest,quote}') = 'string' FROM brain_task_events e
                WHERE e.owner_id = t.owner_id AND e.task_id = t.id AND e.action = 'claimed'
                ORDER BY e.id DESC LIMIT 1)) v
       ORDER BY ${ORDER.priority("ASC")} LIMIT $2`,
      [ownerId, NEEDS_YOU_SECTION_LIMIT],
    ),
    db.query(
      `SELECT count(*)::int AS count FROM brain_task_suggestions s
       JOIN brain_tasks t ON t.owner_id = s.owner_id AND t.id = s.task_id
       WHERE s.owner_id = $1 AND s.status = 'open' AND t.archived_at IS NULL`,
      [ownerId],
    ),
  ]);
  const rows = sectioned.rows;
  const totals = Object.fromEntries(
    NEEDS_YOU_SECTIONS.map((section) => [
      section,
      (rows.find((row) => row.section === section)?.section_total ??
        0) as number,
    ]),
  ) as Record<NeedsYouSection, number> & {
    onRequest: number;
    suggestions: number;
  };
  totals.onRequest = (requested.rows[0]?.total_count ?? 0) as number;
  totals.suggestions = suggestionCount.rows[0].count as number;
  const inSection = (section: NeedsYouSection) =>
    rows.filter((row) => row.section === section);
  const triage = inSection("triage").map(taskRow);
  const asking = [
    ...inSection("questions"),
    ...inSection("staleQuestions"),
  ].map(taskRow);
  const claimed = requested.rows.map(taskRow);
  const [sources, asked, claims, suggestions] = await Promise.all([
    sourcesOf(
      ownerId,
      triage.map((task) => task.id),
    ),
    latestEvents(
      ownerId,
      asking.map((task) => task.id),
      "asked",
    ),
    latestEvents(
      ownerId,
      claimed.map((task) => task.id),
      "claimed",
    ),
    querySuggestions(ownerId),
  ]);
  const batchPages = await pageTitles(
    ownerId,
    triage.flatMap((task) => {
      const batch = task.batchId ? parseTaskBatchId(task.batchId) : null;
      return batch ? [batch.pageId] : [];
    }),
  );

  const batches = new Map<string, TriageBatch>();
  for (const task of triage) {
    const batch = task.batchId ? parseTaskBatchId(task.batchId) : null;
    const key = batch ? `batch:${task.batchId}` : `agent:${task.createdBy.id}`;
    let group = batches.get(key);
    if (!group) {
      const page = batch ? batchPages.get(batch.pageId) : undefined;
      group = {
        key,
        batchId: batch ? task.batchId : null,
        source:
          batch && page
            ? {
                id: page.id,
                slug: page.slug,
                title: page.title,
                version: batch.pageVersion,
              }
            : null,
        createdBy: task.createdBy,
        tasks: [],
      };
      batches.set(key, group);
    }
    group.tasks.push({ ...task, source: sources.get(task.id) ?? null });
  }

  const question = (task: TaskRow) => {
    const event = asked.get(task.id);
    return {
      task,
      prompt:
        task.statusNote ??
        (event?.note
          ? authored(event.note as string, {
              label: event.actor_label,
              kind: "agent",
            })
          : null),
      choices: choicesOf(event?.payload),
      askedBy: (event?.actor_label as string | undefined) ?? null,
      askedAt: task.inputRequestedAt,
      stale: false,
    };
  };

  const onRequest = claimed.flatMap((task) => {
    const payload = (claims.get(task.id)?.payload ?? {}) as Record<
      string,
      unknown
    >;
    const request = payload.ownerRequest as { quote?: unknown } | undefined;
    if (!request || typeof request.quote !== "string") return [];
    return [
      {
        task,
        quote: authored(request.quote, {
          label: task.claimedBy?.label ?? "Agent",
          kind: "agent",
        }),
        leads: Array.isArray(payload.leads)
          ? payload.leads.filter(
              (lead): lead is string => typeof lead === "string",
            )
          : [],
        claimedAt: iso(claims.get(task.id)?.created_at),
      },
    ];
  });

  return {
    triage: [...batches.values()],
    questions: inSection("questions").map(taskRow).map(question),
    staleQuestions: inSection("staleQuestions")
      .map(taskRow)
      .map((task) => ({ ...question(task), stale: true })),
    reviews: inSection("reviews").map(taskView),
    humanSteps: inSection("humanSteps").map(taskRow),
    onRequest,
    suggestions,
    /** Full counts per section; a section shows at most its first rows. */
    totals,
  };
}

/** The navigation badge: every item that waits for an owner decision. */
export async function queryNeedsYouCount(ownerId: string): Promise<number> {
  assertOwner(ownerId);
  const { rows } = await getPool().query(
    `SELECT
       (SELECT count(*) FROM brain_tasks t WHERE t.owner_id = $1 AND t.archived_at IS NULL AND (
          t.status IN ('triage','needs_input','in_review')
          OR (t.status = 'ready' AND t.approved_at IS NULL)
          OR (t.status = 'blocked' AND t.blocked_reason = 'human_step')))
       + (SELECT count(*) FROM brain_task_suggestions s
          JOIN brain_tasks t ON t.owner_id = s.owner_id AND t.id = s.task_id
          WHERE s.owner_id = $1 AND s.status = 'open' AND t.archived_at IS NULL) AS count`,
    [ownerId],
  );
  return Number(rows[0].count);
}

/**
 * The live refresh cursor: the newest task event plus what changes without
 * one (suggestions opened, expired or decided by nightly maintenance, and the
 * owner's settings such as saved views). Opaque; compared by equality.
 */
export async function queryTaskWatermark(ownerId: string): Promise<string> {
  assertOwner(ownerId);
  const { rows } = await getPool().query(
    `SELECT
       (SELECT coalesce(max(id), 0) FROM brain_task_events WHERE owner_id = $1)::text AS events,
       s.total::text, s.open::text, s.stamp::text,
       coalesce((SELECT floor(extract(epoch FROM updated_at) * 1000000)::bigint
                 FROM brain_task_settings WHERE owner_id = $1), 0)::text AS settings
     FROM (SELECT count(*) AS total, count(*) FILTER (WHERE status = 'open') AS open,
             coalesce(floor(extract(epoch FROM max(updated_at)) * 1000000)::bigint, 0) AS stamp
           FROM brain_task_suggestions WHERE owner_id = $1) s`,
    [ownerId],
  );
  const row = rows[0];
  return [row.events, row.total, row.open, row.stamp, row.settings].join(".");
}

/** The shape of queryTaskWatermark, for validating a client's cursor. */
export const TASK_WATERMARK = /^\d{1,20}(?:\.\d{1,20}){4}$/;

/** One task for the detail page: the view, the open question and the claim. */
export async function queryTaskDetail(ownerId: string, ref: string) {
  assertOwner(ownerId);
  const db = getPool();
  const row = await loadTaskRow(db, ownerId, ref);
  const task = {
    ...taskView(row),
    delegateId: row.delegate_agent_id as string | null,
    createdById: row.created_by_agent_id as string,
  };
  const [asked, claimed, dependencies, children, sources] = await Promise.all([
    task.status === "needs_input"
      ? latestEvents(ownerId, [task.id], "asked")
      : Promise.resolve(new Map<string, QueryResultRow>()),
    task.claimedBy
      ? latestEvents(ownerId, [task.id], "claimed")
      : Promise.resolve(new Map<string, QueryResultRow>()),
    db.query(
      `SELECT 'blockedBy' AS direction, b.number, b.title, b.status, a.label, a.kind FROM brain_task_dependencies d
         JOIN brain_tasks b ON b.owner_id = d.owner_id AND b.id = d.depends_on_task_id
         JOIN brain_agents a ON a.owner_id = b.owner_id AND a.id = b.created_by_agent_id
         WHERE d.owner_id = $1 AND d.task_id = $2
       UNION ALL
       SELECT 'blocks', b.number, b.title, b.status, a.label, a.kind FROM brain_task_dependencies d
         JOIN brain_tasks b ON b.owner_id = d.owner_id AND b.id = d.task_id
         JOIN brain_agents a ON a.owner_id = b.owner_id AND a.id = b.created_by_agent_id
         WHERE d.owner_id = $1 AND d.depends_on_task_id = $2
       ORDER BY 1, 2`,
      [ownerId, task.id],
    ),
    db.query(
      `SELECT c.number, c.title, c.status, a.label, a.kind FROM brain_tasks c
       JOIN brain_agents a ON a.owner_id = c.owner_id AND a.id = c.created_by_agent_id
       WHERE c.owner_id = $1 AND c.parent_task_id = $2 AND c.archived_at IS NULL
       ORDER BY c.number LIMIT 50`,
      [ownerId, task.id],
    ),
    sourcesOf(ownerId, [task.id]),
  ]);
  const relation = (row: QueryResultRow) => ({
    ref: formatTaskRef(row.number),
    title: authored(row.title as string, { label: row.label, kind: row.kind }),
    status: row.status as string,
  });
  const question = asked.get(task.id);
  const claim = (claimed.get(task.id)?.payload ?? null) as Record<
    string,
    unknown
  > | null;
  const quote = (claim?.ownerRequest as { quote?: unknown } | undefined)?.quote;
  return {
    task,
    question:
      task.status === "needs_input"
        ? {
            prompt: task.statusNote,
            choices: choicesOf(question?.payload),
            askedBy: (question?.actor_label as string | undefined) ?? null,
            askedAt: task.inputRequestedAt,
            stale: task.inputRequestedAt
              ? new Date(task.inputRequestedAt).getTime() <
                Date.now() - QUESTION_STALE_DAYS * 86_400_000
              : false,
          }
        : null,
    onRequest:
      typeof quote === "string"
        ? {
            quote: authored(quote, {
              label: task.claimedBy?.label ?? "Agent",
              kind: "agent",
            }),
            leads: Array.isArray(claim?.leads)
              ? (claim.leads as unknown[]).filter(
                  (lead): lead is string => typeof lead === "string",
                )
              : [],
          }
        : null,
    dependencies: {
      blockedBy: dependencies.rows
        .filter((row) => row.direction === "blockedBy")
        .map(relation),
      blocks: dependencies.rows
        .filter((row) => row.direction === "blocks")
        .map(relation),
    },
    children: children.rows.map(relation),
    source: sources.get(task.id) ?? null,
  };
}
export type TaskDetail = Awaited<ReturnType<typeof queryTaskDetail>>;

export async function queryTaskKnowledge(ownerId: string, taskId: string) {
  assertOwner(ownerId);
  return listTaskLinks(getPool(), ownerId, taskId, ["active", "suggested"]);
}

export async function queryTaskActivity(ownerId: string, taskId: string) {
  assertOwner(ownerId);
  return recentEvents(getPool(), ownerId, taskId, 100);
}

export async function queryTaskParties(ownerId: string, taskId: string) {
  assertOwner(ownerId);
  return listTaskParties(getPool(), ownerId, taskId);
}

/**
 * Tasks with a typed due date in [from, to] (owner's time zone), and the open
 * approximate or event deadlines, which the calendar lists apart.
 */
export async function queryTaskCalendar(
  ownerId: string,
  from: string,
  to: string,
) {
  assertOwner(ownerId);
  const db = getPool();
  const [dated, loose] = await Promise.all([
    db.query(
      `${TASK_VIEW_SELECT}
       WHERE t.owner_id = $1 AND t.archived_at IS NULL AND t.status <> 'canceled'
         AND t.due_kind IN ('date','datetime','hard')
         AND COALESCE(t.due_on, (t.due_at AT TIME ZONE 'Europe/Rome')::date) BETWEEN $2::date AND $3::date
       ORDER BY due_key, t.due_at NULLS FIRST, t.priority, t.number
       LIMIT 500`,
      [ownerId, from, to],
    ),
    db.query(
      `${TASK_VIEW_SELECT}
       WHERE t.owner_id = $1 AND t.archived_at IS NULL
         AND t.status = ANY($2::text[]) AND t.due_kind IN ('approximate','event')
       ORDER BY due_key, t.priority, t.number
       LIMIT 100`,
      [ownerId, OPEN_TASK_STATUSES],
    ),
  ]);
  return { dated: dated.rows.map(taskRow), loose: loose.rows.map(taskRow) };
}

const RECENT_DONE_DAYS = 14;
/** Cards per board column; each column reports its full count. */
export const BOARD_COLUMN_LIMIT = 100;

/**
 * Open tasks by status, with recently done ones, for the board. Each column
 * keeps its first cards in priority order and its total, so a crowded column
 * never empties another one.
 */
export async function queryTaskBoard(
  ownerId: string,
  filters: TaskBoardFilters,
) {
  assertOwner(ownerId);
  const { params, add } = builder(ownerId);
  const where = ["t.owner_id = $1", "t.archived_at IS NULL"];
  if (filters.projectId && UUID.test(filters.projectId))
    where.push(`t.project_page_id = ${add(filters.projectId)}::uuid`);
  if (filters.query) where.push(textMatch(add, filters.query));
  const open = add(OPEN_TASK_STATUSES);
  const limit = add(BOARD_COLUMN_LIMIT);
  const { rows } = await getPool().query(
    `SELECT v.* FROM (
       SELECT v.*, row_number() OVER (PARTITION BY v.status ORDER BY ${ORDER.priority("ASC")}) AS column_rank,
         count(*) OVER (PARTITION BY v.status)::int AS column_total
       FROM (${TASK_VIEW_SELECT} WHERE ${where.join(" AND ")}
         AND (t.status = ANY(${open}::text[])
              OR (t.status = 'done' AND t.completed_at > now() - interval '${RECENT_DONE_DAYS} days'))) v
     ) v
     WHERE v.column_rank <= ${limit}
     ORDER BY ${ORDER.priority("ASC")}`,
    params,
  );
  const totals: Partial<Record<TaskStatus, number>> = {};
  for (const row of rows)
    totals[row.status as TaskStatus] = row.column_total as number;
  return { tasks: rows.map(taskRow), totals };
}
export type TaskBoardData = Awaited<ReturnType<typeof queryTaskBoard>>;

/** A project page's open tasks, its pause and its task keeper exclusion. */
export async function queryProjectTasks(ownerId: string, pageId: string) {
  assertOwner(ownerId);
  const [{ rows }, settings] = await Promise.all([
    getPool().query(
      `SELECT v.*, count(*) OVER ()::int AS total_count
       FROM (${TASK_VIEW_SELECT} WHERE t.owner_id = $1 AND t.archived_at IS NULL
             AND t.project_page_id = $2::uuid AND t.status = ANY($3::text[])) v
       ORDER BY ${ORDER.priority("ASC")} LIMIT 20`,
      [ownerId, pageId, OPEN_TASK_STATUSES],
    ),
    getTaskSettings(ownerId),
  ]);
  return {
    tasks: rows.map(taskRow),
    total: (rows[0]?.total_count ?? 0) as number,
    paused: settings.pausedProjectIds.includes(pageId),
  };
}

/** Open tasks where a person page is a participant or a stakeholder. */
export async function queryPersonTasks(ownerId: string, pageId: string) {
  assertOwner(ownerId);
  const db = getPool();
  const { rows } = await db.query(
    `SELECT v.*, count(*) OVER ()::int AS total_count
     FROM (${TASK_VIEW_SELECT} WHERE t.owner_id = $1 AND t.archived_at IS NULL AND t.status = ANY($3::text[])
       AND (EXISTS (SELECT 1 FROM brain_task_parties p WHERE p.owner_id = t.owner_id AND p.task_id = t.id AND p.person_page_id = $2::uuid)
         OR EXISTS (SELECT 1 FROM brain_task_links l WHERE l.owner_id = t.owner_id AND l.task_id = t.id
                    AND l.page_id = $2::uuid AND l.role = 'stakeholder' AND l.status = 'active'))) v
     ORDER BY ${ORDER.priority("ASC")} LIMIT 20`,
    [ownerId, pageId, OPEN_TASK_STATUSES],
  );
  const tasks = rows.map(taskRow);
  const roles = tasks.length
    ? await db.query(
        `SELECT task_id, array_agg(DISTINCT role ORDER BY role) AS roles FROM brain_task_parties
         WHERE owner_id = $1 AND person_page_id = $2::uuid AND task_id = ANY($3::uuid[]) GROUP BY task_id`,
        [ownerId, pageId, tasks.map((task) => task.id)],
      )
    : { rows: [] };
  const byTask = new Map(
    roles.rows.map((row) => [row.task_id as string, row.roles as string[]]),
  );
  return {
    tasks: tasks.map((task) => ({
      ...task,
      roles: byTask.get(task.id) ?? ["stakeholder"],
    })),
    total: (rows[0]?.total_count ?? 0) as number,
  };
}

/** Delegates and required capabilities come from the /agents registry. */
export async function queryTaskFormChoices(ownerId: string) {
  assertOwner(ownerId);
  const agents = (await listAgents(ownerId))
    .filter((agent) => agent.kind === "agent" && !agent.disabledAt)
    .map((agent) => ({
      id: agent.id,
      label: agent.label,
      labelVerified: agent.labelVerified,
      capabilities: agent.capabilities,
    }));
  const capabilities = [
    ...new Set(agents.flatMap((agent) => agent.capabilities)),
  ].sort((a, b) => a.localeCompare(b));
  return { agents, capabilities };
}
export type TaskFormChoices = Awaited<ReturnType<typeof queryTaskFormChoices>>;

export async function queryTaskSettings(ownerId: string) {
  return getTaskSettings(ownerId);
}

/** Pages the task keeper never reads, for Operations (deleted pages drop out). */
export async function queryKeeperExclusions(ownerId: string) {
  assertOwner(ownerId);
  const { keeperExcludedPageIds } = await getTaskSettings(ownerId);
  if (!keeperExcludedPageIds.length) return [];
  const { rows } = await getPool().query(
    `SELECT id, slug, title, type FROM brain_pages
     WHERE owner_id = $1 AND id = ANY($2::uuid[]) ORDER BY lower(title), id`,
    [ownerId, keeperExcludedPageIds],
  );
  return rows.map((row) => ({
    id: row.id as string,
    slug: row.slug as string,
    title: row.title as string,
    type: row.type as string,
  }));
}

export const TASK_STATUS_ORDER: readonly TaskStatus[] = [
  "triage",
  "ready",
  "in_progress",
  "needs_input",
  "blocked",
  "in_review",
  "on_hold",
  "done",
];
