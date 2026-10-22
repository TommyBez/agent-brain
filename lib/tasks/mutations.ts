import type { Database } from "../brain/pages";
import type { Actor } from "./actors";
import { taskError } from "./errors";
import { latestClaim, recordEvent } from "./events";
import type { LockedTask } from "./records";
import type { TaskStatus } from "./types";

// Shared building blocks of task mutations. Callers hold the row lock.

const UPDATABLE = new Set([
  "title",
  "description",
  "acceptance_criteria",
  "expected_output",
  "status",
  "blocked_reason",
  "status_note",
  "priority",
  "due_kind",
  "due_on",
  "due_at",
  "due_text",
  "requires_human",
  "review_policy",
  "delegate_agent_id",
  "required_capability",
  "project_page_id",
  "parent_task_id",
  "approved_by_agent_id",
  "claimed_by_agent_id",
  "lease_id",
  "lease_expires_at",
  "claimed_at",
  "input_requested_at",
  "completion",
  "completed_lease_hash",
  "completed_at",
  "archived_at",
]);

/** Assignments are an allowlist; `raw` holds fixed SQL such as `version = version + 1`. */
export async function updateTaskRow(
  db: Database,
  ownerId: string,
  taskId: string,
  sets: Record<string, unknown>,
  raw: string[] = [],
) {
  const keys = Object.keys(sets);
  for (const key of keys)
    if (!UPDATABLE.has(key)) throw new Error(`Unexpected task column ${key}`);
  const assignments = [
    ...keys.map((key, index) =>
      key === "completion"
        ? `${key} = $${index + 3}::jsonb`
        : `${key} = $${index + 3}`,
    ),
    ...raw,
    "updated_at = now()",
  ];
  await db.query(
    `UPDATE brain_tasks SET ${assignments.join(", ")} WHERE owner_id = $1 AND id = $2`,
    [
      ownerId,
      taskId,
      ...keys.map((key) =>
        key === "completion" && sets[key] !== null
          ? JSON.stringify(sets[key])
          : sets[key],
      ),
    ],
  );
}

/** Columns that end a claim; the lease id is never kept once released. */
export const CLEARED_LEASE = {
  claimed_by_agent_id: null,
  lease_id: null,
  lease_expires_at: null,
  claimed_at: null,
  input_requested_at: null,
} as const;

export function isOwnerActor(actor: Actor): boolean {
  return actor.agent.kind === "owner";
}

export function assertOwnerActor(actor: Actor) {
  if (!isOwnerActor(actor))
    throw taskError(
      "NOT_ALLOWED",
      "Only the owner can do this, in the Agent Brain app.",
      "Show the owner the task link so they can act in the app; never ask another agent to do it.",
    );
}

/** Claims, reports, releases and completions belong to connected agents. */
export function assertWorker(actor: Actor) {
  if (actor.agent.kind !== "agent")
    throw taskError(
      "NOT_ALLOWED",
      "Only connected agents claim and work tasks.",
      "The owner starts work from the app; system processes never claim tasks.",
    );
}

export function assertVersion(task: LockedTask, expected: number | undefined) {
  if (expected !== undefined && task.version !== expected)
    throw taskError(
      "TASK_VERSION_CONFLICT",
      `${task.ref} changed after it was read (version ${task.version}, expected ${expected}).`,
      "Read the task again with read_task, reconcile your change with the current version and retry; never overwrite blindly.",
      {
        ref: task.ref,
        expectedVersion: expected,
        currentVersion: task.version,
      },
    );
}

/**
 * Where a released claim goes: an approved task returns to ready; an
 * unapproved one to the state it was claimed from (a claim never approves).
 */
export async function releaseTarget(
  db: Database,
  ownerId: string,
  task: Pick<LockedTask, "id" | "approved_at">,
): Promise<TaskStatus> {
  if (task.approved_at) return "ready";
  const claim = await latestClaim(db, ownerId, task.id);
  return claim.startStatus === "triage" ? "triage" : "ready";
}

/**
 * Dependents explicitly blocked on dependencies become ready again (or return
 * to triage if never approved) once every task they depend on is done.
 */
export async function unblockDependents(
  db: Database,
  ownerId: string,
  task: Pick<LockedTask, "id" | "ref">,
  actorAgentId: string,
) {
  const dependents = await lockDependencyBlockedDependents(
    db,
    ownerId,
    task.id,
  );
  if (!dependents.length) return 0;
  return releaseDependencyBlocks(db, ownerId, dependents, actorAgentId, {
    cause: "dependencies_done",
    completed: task.ref,
  });
}

/**
 * Locks the tasks blocked on dependencies that depend on `taskId`, in id
 * order, before the caller checks their other blockers in a new statement:
 * when two blockers finish together, the second transaction waits here for
 * the first to commit and then sees its blocker as done.
 */
export async function lockDependencyBlockedDependents(
  db: Database,
  ownerId: string,
  taskId: string,
): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT t.id FROM brain_tasks t
     JOIN brain_task_dependencies d ON d.owner_id = t.owner_id AND d.task_id = t.id
     WHERE d.owner_id = $1 AND d.depends_on_task_id = $2
       AND t.status = 'blocked' AND t.blocked_reason = 'dependency' AND t.archived_at IS NULL
     ORDER BY t.id FOR UPDATE OF t`,
    [ownerId, taskId],
  );
  return rows.map((row) => row.id);
}

/**
 * Locked tasks blocked on dependencies with no unfinished dependency left go
 * back to ready, or to triage if never approved.
 */
export async function releaseDependencyBlocks(
  db: Database,
  ownerId: string,
  taskIds: string[],
  actorAgentId: string,
  payload: Record<string, unknown>,
) {
  const { rows } = await db.query(
    `UPDATE brain_tasks u SET status = CASE WHEN u.approved_at IS NULL THEN 'triage' ELSE 'ready' END,
       blocked_reason = NULL, status_note = NULL, version = u.version + 1, updated_at = now()
     WHERE u.owner_id = $1 AND u.id = ANY($2::uuid[]) AND u.archived_at IS NULL
       AND u.status = 'blocked' AND u.blocked_reason = 'dependency'
       AND NOT EXISTS (
         SELECT 1 FROM brain_task_dependencies d2
         JOIN brain_tasks b ON b.owner_id = d2.owner_id AND b.id = d2.depends_on_task_id
         WHERE d2.owner_id = $1 AND d2.task_id = u.id AND b.status <> 'done')
     RETURNING u.id, u.status`,
    [ownerId, taskIds],
  );
  for (const row of rows)
    await recordEvent(db, {
      ownerId,
      taskId: row.id,
      actorAgentId,
      action: "status_changed",
      fromStatus: "blocked",
      toStatus: row.status,
      payload,
    });
  return rows.length;
}
