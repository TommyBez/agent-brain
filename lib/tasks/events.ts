import type { Database } from "../brain/pages";
import { assertOwner } from "../brain/utils";
import { getPool, transaction } from "../db";
import { parseTaskInput, taskNotFound } from "./errors";
import { EVENT_SELECT, eventView, iso, refCondition } from "./records";
import { eventsSinceSchema } from "./schemas";
import { TASK_LIMITS, type TaskEventAction, type TaskStatus } from "./types";

export interface TaskEventInput {
  ownerId: string;
  taskId: string | null;
  actorAgentId: string;
  action: TaskEventAction;
  fromStatus?: string | null;
  toStatus?: string | null;
  note?: string | null;
  /** Never the lease id. `statusNote: true` marks the event that wrote status_note. */
  payload?: Record<string, unknown>;
}

/** Append-only history; the caller's transaction makes it atomic with the change. */
export async function recordEvent(db: Database, event: TaskEventInput) {
  const note = event.note ? event.note.slice(0, TASK_LIMITS.eventNote) : null;
  await db.query(
    `INSERT INTO brain_task_events (owner_id, task_id, actor_agent_id, action, from_status, to_status, note, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      event.ownerId,
      event.taskId,
      event.actorAgentId,
      event.action,
      event.fromStatus ?? null,
      event.toStatus ?? null,
      note || null,
      JSON.stringify(event.payload ?? {}),
    ],
  );
}

export async function recentEvents(
  db: Database,
  ownerId: string,
  taskId: string,
  limit: number,
) {
  if (limit <= 0) return [];
  const { rows } = await db.query(
    `${EVENT_SELECT} WHERE e.owner_id = $1 AND e.task_id = $2 ORDER BY e.id DESC LIMIT $3`,
    [ownerId, taskId, limit],
  );
  return rows.reverse().map(eventView);
}

/**
 * Notes for a claim brief: the latest questions, answers, handoffs and review
 * notes, and separately the latest progress reports, so routine reports and
 * other events never push the owner's notes out of the window.
 */
export async function briefEvents(
  db: Database,
  ownerId: string,
  taskId: string,
) {
  const { rows } = await db.query(
    `${EVENT_SELECT} WHERE e.id IN (
       (SELECT id FROM brain_task_events
        WHERE owner_id = $1 AND task_id = $2 AND note IS NOT NULL
          AND action IN ('asked', 'answered', 'released', 'reviewed')
        ORDER BY id DESC LIMIT 24)
       UNION ALL
       (SELECT id FROM brain_task_events
        WHERE owner_id = $1 AND task_id = $2 AND note IS NOT NULL
          AND action = 'reported'
        ORDER BY id DESC LIMIT 12))
     ORDER BY e.id`,
    [ownerId, taskId],
  );
  return rows.map(eventView);
}

/** The owner's answer to the holder's latest question, once given. */
export async function latestOwnerAnswer(
  db: Database,
  ownerId: string,
  taskId: string,
): Promise<{
  answer: string;
  choice: string | null;
  answeredAt: string;
} | null> {
  const { rows } = await db.query(
    `SELECT e.note, e.payload->>'choice' AS choice, e.created_at FROM brain_task_events e
     WHERE e.owner_id = $1 AND e.task_id = $2 AND e.action = 'answered'
       AND e.id > coalesce((SELECT max(q.id) FROM brain_task_events q
                            WHERE q.owner_id = $1 AND q.task_id = $2 AND q.action = 'asked'), 0)
     ORDER BY e.id DESC LIMIT 1`,
    [ownerId, taskId],
  );
  return rows[0]
    ? {
        answer: rows[0].note,
        choice: rows[0].choice,
        answeredAt: iso(rows[0].created_at) as string,
      }
    : null;
}

/** The latest claim of a task: its start state and lease length. */
export async function latestClaim(
  db: Database,
  ownerId: string,
  taskId: string,
): Promise<{
  startStatus: TaskStatus | null;
  leaseMinutes: number | null;
  onOwnerRequest: boolean;
}> {
  const { rows } = await db.query(
    `SELECT payload FROM brain_task_events
     WHERE owner_id = $1 AND task_id = $2 AND action = 'claimed'
     ORDER BY id DESC LIMIT 1`,
    [ownerId, taskId],
  );
  const payload = (rows[0]?.payload ?? {}) as Record<string, unknown>;
  return {
    startStatus:
      typeof payload.startStatus === "string"
        ? (payload.startStatus as TaskStatus)
        : null,
    leaseMinutes:
      typeof payload.leaseMinutes === "number" ? payload.leaseMinutes : null,
    onOwnerRequest: Boolean(payload.ownerRequest),
  };
}

/** Whether this agent ever claimed the task: an old holder, not a stranger. */
export async function everClaimedBy(
  db: Database,
  ownerId: string,
  taskId: string,
  agentId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM brain_task_events
     WHERE owner_id = $1 AND task_id = $2 AND action = 'claimed' AND actor_agent_id = $3 LIMIT 1`,
    [ownerId, taskId, agentId],
  );
  return Boolean(rowCount);
}

// events_since: a cursor is "<xid8>:<event id>". Only transactions older than
// the snapshot's xmin are certainly finished, so the watermark never passes an
// event that a slower transaction has yet to commit.

export interface EventCursor {
  tx: string;
  id: string;
}

export function parseEventCursor(cursor: string | undefined): EventCursor {
  if (!cursor) return { tx: "0", id: "0" };
  const [tx, id] = cursor.split(":");
  return { tx, id };
}

export const formatEventCursor = (cursor: EventCursor) =>
  `${cursor.tx}:${cursor.id}`;

export async function eventWatermark(db: Database): Promise<string> {
  const { rows } = await db.query(
    "SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS watermark",
  );
  return rows[0].watermark;
}

/** Events committed after `cursor`, in commit-safe order, for polling clients. */
export async function eventsSince(ownerId: string, input: unknown) {
  assertOwner(ownerId);
  const data = parseTaskInput(eventsSinceSchema, input);
  const after = parseEventCursor(data.cursor);
  return transaction(async (db) => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const watermark = await eventWatermark(db);
    const params: unknown[] = [ownerId, after.tx, after.id, watermark];
    let taskFilter = "";
    if (data.ref) {
      const where = refCondition(data.ref, 2);
      const task = await db.query(
        `SELECT t.id FROM brain_tasks t WHERE t.owner_id = $1 AND ${where.sql}`,
        [ownerId, ...where.params],
      );
      if (!task.rows[0]) throw taskNotFound(data.ref);
      params.push(task.rows[0].id);
      taskFilter = "AND e.task_id = $5";
    }
    const { rows } = await db.query(
      `${EVENT_SELECT}
       WHERE e.owner_id = $1 AND (e.tx, e.id) > ($2::xid8, $3::bigint) AND e.tx < $4::xid8 ${taskFilter}
       ORDER BY e.tx, e.id LIMIT ${data.limit + 1}`,
      params,
    );
    const hasMore = rows.length > data.limit;
    const page = rows.slice(0, data.limit);
    const last = page.at(-1);
    const cursor: EventCursor =
      hasMore && last
        ? { tx: last.tx, id: String(last.id) }
        : { tx: watermark, id: "0" };
    return {
      events: page.map(eventView),
      cursor: formatEventCursor(cursor),
      hasMore,
    };
  });
}

/** The latest event id, for the app's cheap "something changed" polling. */
export async function latestTaskEventId(ownerId: string): Promise<number> {
  assertOwner(ownerId);
  const { rows } = await getPool().query(
    "SELECT coalesce(max(id), 0)::text AS id FROM brain_task_events WHERE owner_id = $1",
    [ownerId],
  );
  return Number(rows[0].id);
}
