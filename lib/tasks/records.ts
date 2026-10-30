import type { QueryResultRow } from "pg";
import type { Database } from "../brain/pages";
import { taskNotFound } from "./errors";
import {
  type AgentKind,
  formatTaskRef,
  parseTaskRef,
  TASK_PRIORITY_LABELS,
  type TaskCompletion,
} from "./types";

/**
 * Text written by the owner or an agent. Only the owner's text is trusted;
 * everything else is reference data that must never be followed as orders.
 */
export interface Authored<T> {
  value: T;
  untrusted: boolean;
  authoredBy: string;
}
export interface Author {
  label: string;
  kind: AgentKind | string;
}

export function authored<T>(value: T, author: Author): Authored<T> {
  return {
    value,
    untrusted: author.kind !== "owner",
    authoredBy: author.label,
  };
}

export const iso = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined ? null : new Date(value).toISOString();

/** The completion report as stored: the protocol fields plus verification. */
export interface StoredCompletion extends TaskCompletion {
  pagesChanged: { ref: string; version: number }[];
  producedLinks: ProducedLink[];
  ignoredPages: { ref: string; reason: string }[];
  completedByAgentId: string;
  completedByLabel: string;
  completedByKind: string;
}
export interface ProducedLink {
  pageId: string;
  slug: string;
  version: number;
  status: "active" | "suggested";
}

// Never select lease_id into a view: it is the fencing secret.
export const TASK_VIEW_SELECT = `SELECT t.id, t.number, t.title, t.description, t.acceptance_criteria,
  t.expected_output, t.status, t.blocked_reason, t.status_note, t.priority, t.due_kind,
  to_char(t.due_on, 'YYYY-MM-DD') AS due_on, t.due_at, t.due_text, t.requires_human,
  t.review_policy, t.delegate_agent_id, t.required_capability, t.project_page_id,
  t.parent_task_id, t.origin, t.owner_quote, t.created_by_agent_id, t.approved_at,
  t.claimed_by_agent_id, t.lease_expires_at, t.claimed_at, t.input_requested_at,
  t.claim_count, t.completion, t.completed_at, t.version, t.batch_id, t.recurrence_id,
  to_char(t.occurrence_on, 'YYYY-MM-DD') AS occurrence_on, t.archived_at, t.created_at, t.updated_at,
  COALESCE(t.due_on, (t.due_at AT TIME ZONE 'Europe/Rome')::date, 'infinity'::date)::text AS due_key,
  creator.label AS creator_label, creator.kind AS creator_kind, creator.label_verified AS creator_label_verified,
  holder.label AS holder_label, delegate.label AS delegate_label, approver.label AS approver_label,
  holder.label_verified AS holder_label_verified, delegate.label_verified AS delegate_label_verified,
  project.slug AS project_slug, project.title AS project_title, project.type AS project_type,
  parent.number AS parent_number,
  note_author.label AS note_label, note_author.kind AS note_kind,
  (SELECT count(*)::int FROM brain_task_dependencies d
     JOIN brain_tasks b ON b.owner_id = d.owner_id AND b.id = d.depends_on_task_id
   WHERE d.owner_id = t.owner_id AND d.task_id = t.id AND b.status <> 'done') AS open_blockers
FROM brain_tasks t
JOIN brain_agents creator ON creator.owner_id = t.owner_id AND creator.id = t.created_by_agent_id
LEFT JOIN brain_agents holder ON holder.owner_id = t.owner_id AND holder.id = t.claimed_by_agent_id
LEFT JOIN brain_agents delegate ON delegate.owner_id = t.owner_id AND delegate.id = t.delegate_agent_id
LEFT JOIN brain_agents approver ON approver.owner_id = t.owner_id AND approver.id = t.approved_by_agent_id
LEFT JOIN brain_pages project ON project.owner_id = t.owner_id AND project.id = t.project_page_id
LEFT JOIN brain_tasks parent ON parent.owner_id = t.owner_id AND parent.id = t.parent_task_id
LEFT JOIN LATERAL (
  SELECT a.label, a.kind FROM brain_task_events e
  JOIN brain_agents a ON a.owner_id = e.owner_id AND a.id = e.actor_agent_id
  WHERE e.owner_id = t.owner_id AND e.task_id = t.id AND e.payload ? 'statusNote'
  ORDER BY e.id DESC LIMIT 1
) note_author ON t.status_note IS NOT NULL`;

/** SQL matching one task reference; `$n` placeholders start at `first`. */
export function refCondition(
  ref: string,
  first: number,
  alias = "t",
): { sql: string; params: unknown[] } {
  const parsed = parseTaskRef(ref);
  if (!parsed) throw taskNotFound(ref);
  return parsed.kind === "number"
    ? { sql: `${alias}.number = $${first}`, params: [parsed.number] }
    : { sql: `${alias}.id = $${first}::uuid`, params: [parsed.id] };
}

export async function loadTaskRow(
  db: Database,
  ownerId: string,
  ref: string,
): Promise<QueryResultRow> {
  const where = refCondition(ref, 2);
  const { rows } = await db.query(
    `${TASK_VIEW_SELECT} WHERE t.owner_id = $1 AND ${where.sql}`,
    [ownerId, ...where.params],
  );
  if (!rows[0]) throw taskNotFound(ref);
  return rows[0];
}

/** The locked row every mutation checks: fencing, version and gates. */
export interface LockedTask {
  id: string;
  number: number;
  ref: string;
  title: string;
  status: string;
  blocked_reason: string | null;
  status_note: string | null;
  origin: string;
  created_by_agent_id: string;
  approved_at: Date | null;
  claimed_by_agent_id: string | null;
  lease_id: string | null;
  lease_expires_at: Date | null;
  lease_live: boolean;
  claimed_at: Date | null;
  claim_count: number;
  input_requested_at: Date | null;
  version: number;
  review_policy: string;
  expected_output: string;
  acceptance_criteria: string[];
  project_page_id: string | null;
  project_is_project: boolean | null;
  delegate_agent_id: string | null;
  required_capability: string | null;
  requires_human: boolean;
  archived_at: Date | null;
  completion: StoredCompletion | null;
  completed_lease_hash: string | null;
  extraction_fingerprint: string | null;
}

export async function lockTask(
  db: Database,
  ownerId: string,
  ref: string,
): Promise<LockedTask> {
  const where = refCondition(ref, 2);
  const { rows } = await db.query(
    `SELECT t.id, t.number, t.title, t.status, t.blocked_reason, t.status_note, t.origin,
       t.created_by_agent_id, t.approved_at, t.claimed_by_agent_id, t.lease_id,
       t.lease_expires_at, coalesce(t.lease_expires_at > now(), false) AS lease_live,
       t.claimed_at, t.claim_count, t.input_requested_at, t.version, t.review_policy, t.expected_output,
       t.acceptance_criteria, t.project_page_id,
       (SELECT p.type = 'project' FROM brain_pages p WHERE p.owner_id = t.owner_id AND p.id = t.project_page_id) AS project_is_project,
       t.delegate_agent_id, t.required_capability, t.requires_human, t.archived_at,
       t.completion, t.completed_lease_hash, t.extraction_fingerprint
     FROM brain_tasks t WHERE t.owner_id = $1 AND ${where.sql} FOR UPDATE`,
    [ownerId, ...where.params],
  );
  if (!rows[0]) throw taskNotFound(ref);
  return { ...rows[0], ref: formatTaskRef(rows[0].number) } as LockedTask;
}

/** An agent reference; a self-declared token or client name stays unverified. */
function agentRef(label: unknown, verified: unknown) {
  return label
    ? { label: label as string, labelVerified: verified === true }
    : null;
}

function creatorOf(row: QueryResultRow): Author {
  return { label: row.creator_label, kind: row.creator_kind };
}

function dueView(row: QueryResultRow) {
  return {
    kind: row.due_kind,
    on: row.due_on,
    at: iso(row.due_at),
    text: row.due_text === null ? null : authored(row.due_text, creatorOf(row)),
  };
}

function statusNoteView(row: QueryResultRow) {
  if (row.status_note === null) return null;
  // Notes are written by holders, the owner or the task's creator.
  const author: Author = row.note_label
    ? { label: row.note_label, kind: row.note_kind }
    : { label: row.holder_label ?? row.creator_label, kind: "agent" };
  return authored(row.status_note as string, author);
}

export function completionView(completion: StoredCompletion | null) {
  if (!completion) return null;
  return {
    ...authored(
      {
        summary: completion.summary,
        criteria: completion.criteria,
        artifacts: completion.artifacts,
        remaining: completion.remaining ?? null,
      },
      { label: completion.completedByLabel, kind: completion.completedByKind },
    ),
    producedLinks: completion.producedLinks,
    ignoredPages: completion.ignoredPages,
  };
}

export type TaskView = ReturnType<typeof taskView>;

/** The full task as agents and the app see it; never the lease id. */
export function taskView(row: QueryResultRow) {
  const author = creatorOf(row);
  return {
    ref: formatTaskRef(row.number),
    id: row.id as string,
    number: row.number as number,
    title: authored(row.title as string, author),
    description: authored(row.description as string, author),
    acceptanceCriteria: authored(row.acceptance_criteria as string[], author),
    status: row.status as string,
    blockedReason: row.blocked_reason as string | null,
    statusNote: statusNoteView(row),
    priority: row.priority as number,
    priorityLabel: TASK_PRIORITY_LABELS[row.priority as number],
    due: dueView(row),
    expectedOutput: row.expected_output as string,
    reviewPolicy: row.review_policy as string,
    requiresHuman: row.requires_human as boolean,
    project: row.project_page_id
      ? {
          id: row.project_page_id as string,
          slug: row.project_slug as string,
          title: row.project_title as string,
          isProject: row.project_type === "project",
        }
      : null,
    parent: row.parent_number
      ? { ref: formatTaskRef(row.parent_number) }
      : null,
    origin: row.origin as string,
    ownerQuote:
      row.owner_quote === null ? null : authored(row.owner_quote, author),
    createdBy: {
      label: row.creator_label as string,
      kind: row.creator_kind,
      labelVerified: row.creator_label_verified === true,
    },
    approved: row.approved_at !== null,
    approvedAt: iso(row.approved_at),
    approvedBy: row.approver_label ? { label: row.approver_label } : null,
    delegate: agentRef(row.delegate_label, row.delegate_label_verified),
    requiredCapability: row.required_capability as string | null,
    claimedBy: agentRef(row.holder_label, row.holder_label_verified),
    claimedAt: iso(row.claimed_at),
    leaseExpiresAt: iso(row.lease_expires_at),
    inputRequestedAt: iso(row.input_requested_at),
    claimCount: row.claim_count as number,
    openBlockers: row.open_blockers as number,
    completion: completionView(row.completion),
    completedAt: iso(row.completed_at),
    batchId: row.batch_id as string | null,
    version: row.version as number,
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
    archivedAt: iso(row.archived_at),
  };
}

export type TaskListRow = ReturnType<typeof taskListRow>;

/** The compact row of list_tasks. */
export function taskListRow(row: QueryResultRow) {
  return {
    ref: formatTaskRef(row.number),
    id: row.id as string,
    title: authored(row.title as string, creatorOf(row)),
    status: row.status as string,
    blockedReason: row.blocked_reason as string | null,
    statusNote: statusNoteView(row),
    priority: row.priority as number,
    due: dueView(row),
    project: row.project_page_id
      ? { slug: row.project_slug as string, title: row.project_title as string }
      : null,
    claimedBy: agentRef(row.holder_label, row.holder_label_verified),
    delegate: agentRef(row.delegate_label, row.delegate_label_verified),
    approved: row.approved_at !== null,
    leaseExpiresAt: iso(row.lease_expires_at),
    openBlockers: row.open_blockers as number,
    version: row.version as number,
    updatedAt: iso(row.updated_at) as string,
  };
}

/** Payload keys that are bookkeeping, not history. */
const INTERNAL_PAYLOAD_KEYS = new Set(["statusNote"]);

export function eventView(row: QueryResultRow) {
  const payload = Object.fromEntries(
    Object.entries((row.payload ?? {}) as Record<string, unknown>).filter(
      ([key]) => !INTERNAL_PAYLOAD_KEYS.has(key),
    ),
  );
  const number =
    row.task_number ??
    (typeof payload.number === "number" ? payload.number : null);
  return {
    id: Number(row.id),
    ref: number ? formatTaskRef(number) : null,
    action: row.action as string,
    fromStatus: row.from_status as string | null,
    toStatus: row.to_status as string | null,
    actor: { label: row.actor_label as string, kind: row.actor_kind as string },
    untrusted: row.actor_kind !== "owner",
    note: row.note as string | null,
    payload,
    createdAt: iso(row.created_at) as string,
  };
}
export type TaskEventView = ReturnType<typeof eventView>;

export const EVENT_SELECT = `SELECT e.id, e.task_id, e.action, e.from_status, e.to_status, e.note,
  e.payload, e.created_at, e.tx::text AS tx, a.label AS actor_label, a.kind AS actor_kind,
  t.number AS task_number
FROM brain_task_events e
JOIN brain_agents a ON a.owner_id = e.owner_id AND a.id = e.actor_agent_id
LEFT JOIN brain_tasks t ON t.owner_id = e.owner_id AND t.id = e.task_id`;
