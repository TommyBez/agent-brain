import type { Database } from "../brain/pages";
import { getPool, transaction } from "../db";
import type { Actor } from "./actors";
import { parseTaskInput, taskError } from "./errors";
import { recordEvent } from "./events";
import {
  assertOwnerActor,
  assertVersion,
  CLEARED_LEASE,
  lockDependencyBlockedDependents,
  releaseDependencyBlocks,
  releaseTarget,
  unblockDependents,
  updateTaskRow,
} from "./mutations";
import { type LockedTask, loadTaskRow, lockTask, taskView } from "./records";
import {
  answerSchema,
  blockSchema,
  delegateSchema,
  type OwnerFence,
  ownerNoteSchema,
  ownerVersionSchema,
  reviewSchema,
} from "./schemas";
import { rememberRejectedExtraction } from "./service";
import { LEASE_MINUTES, type TaskStatus } from "./types";

// Owner powers. These are Server Action back ends (requireWorkspaceUser →
// ownerActor → here) and never MCP tools: every agent authenticates as the
// owner's delegate, so a tool would hand these powers to injected text.

const ANSWER_RESUME_DAYS = 7;

const OPEN: TaskStatus[] = [
  "triage",
  "ready",
  "in_progress",
  "needs_input",
  "blocked",
  "in_review",
  "on_hold",
];

function invalidTransition(task: LockedTask, action: string): never {
  throw taskError(
    "INVALID_TRANSITION",
    `${task.ref} is ${task.status}; it cannot be ${action}.`,
    "Reload the task and choose an action available for its current state.",
    { ref: task.ref, status: task.status },
  );
}

const sameInstant = (value: Date | null, seen: string | null) =>
  value === null || seen === null
    ? value === seen
    : value.getTime() === Date.parse(seen);

/**
 * The owner decided on what the screen showed: the version, and, since
 * claims and questions never move it, the claim and the question too.
 */
function assertFence(task: LockedTask, fence: OwnerFence) {
  assertVersion(task, fence.expectedVersion);
  const claimChanged =
    (fence.expectedClaimCount !== undefined &&
      task.claim_count !== fence.expectedClaimCount) ||
    (fence.expectedLeaseExpiresAt !== undefined &&
      !sameInstant(task.lease_expires_at, fence.expectedLeaseExpiresAt));
  const questionChanged =
    fence.expectedInputRequestedAt !== undefined &&
    !sameInstant(task.input_requested_at, fence.expectedInputRequestedAt);
  if (claimChanged || questionChanged)
    throw taskError(
      "TASK_VERSION_CONFLICT",
      `${task.ref} changed after it was read: ${claimChanged ? "its claim changed" : "its holder asked a new question"}.`,
      "Load the latest version, then decide again.",
      { ref: task.ref, change: claimChanged ? "claim" : "question" },
    );
}

async function ownerChange<T>(
  actor: Actor,
  ref: string,
  fence: OwnerFence,
  change: (db: Database, task: LockedTask) => Promise<T>,
) {
  assertOwnerActor(actor);
  const result = await transaction(async (db) => {
    const task = await lockTask(db, actor.ownerId, ref);
    assertFence(task, fence);
    await change(db, task);
    return task.id;
  });
  return taskView(await loadTaskRow(getPool(), actor.ownerId, result));
}

async function transition(
  db: Database,
  actor: Actor,
  task: LockedTask,
  to: TaskStatus,
  options: {
    action?:
      | "status_changed"
      | "approved"
      | "released"
      | "reviewed"
      | "answered";
    sets?: Record<string, unknown>;
    raw?: string[];
    note?: string | null;
    payload?: Record<string, unknown>;
  } = {},
) {
  await updateTaskRow(
    db,
    actor.ownerId,
    task.id,
    { status: to, ...(options.sets ?? {}) },
    ["version = version + 1", ...(options.raw ?? [])],
  );
  await recordEvent(db, {
    ownerId: actor.ownerId,
    taskId: task.id,
    actorAgentId: actor.agentId,
    action: options.action ?? "status_changed",
    fromStatus: task.status,
    toStatus: to,
    note: options.note ?? null,
    payload: options.payload ?? {},
  });
}

/** Approve: triage → ready; an unapproved ready task becomes claimable by others. */
export async function approveTask(
  actor: Actor,
  ref: string,
  input: unknown = {},
) {
  const data = parseTaskInput(ownerVersionSchema, input);
  return ownerChange(actor, ref, data, async (db, task) => {
    if (task.approved_at) return;
    if (!OPEN.includes(task.status as TaskStatus))
      invalidTransition(task, "approved");
    const to = task.status === "triage" ? "ready" : (task.status as TaskStatus);
    await transition(db, actor, task, to, {
      action: "approved",
      sets: { approved_by_agent_id: actor.agentId },
      raw: ["approved_at = now()"],
    });
  });
}

/** "Approve all" for one source batch or a list of references. */
export async function approveTasks(actor: Actor, refs: string[]) {
  assertOwnerActor(actor);
  const approved = [];
  for (const ref of refs.slice(0, 100))
    approved.push(await approveTask(actor, ref));
  return approved;
}

/** Only the delegate agent may claim; the owner stays responsible. */
export async function delegateTask(actor: Actor, ref: string, input: unknown) {
  const data = parseTaskInput(delegateSchema, input);
  return ownerChange(actor, ref, data, async (db, task) => {
    if (data.agentId) {
      const agent = await db.query(
        "SELECT 1 FROM brain_agents WHERE owner_id = $1 AND id = $2 AND kind = 'agent' AND disabled_at IS NULL",
        [actor.ownerId, data.agentId],
      );
      if (!agent.rowCount)
        throw taskError(
          "AGENT_NOT_FOUND",
          "That agent is not an active connected agent.",
          "Choose an agent from the /agents registry.",
        );
    }
    if ((task.delegate_agent_id ?? null) === data.agentId) return;
    await updateTaskRow(
      db,
      actor.ownerId,
      task.id,
      { delegate_agent_id: data.agentId },
      ["version = version + 1"],
    );
    await recordEvent(db, {
      ownerId: actor.ownerId,
      taskId: task.id,
      actorAgentId: actor.agentId,
      action: "delegated",
      payload: { agentId: data.agentId },
    });
  });
}

/** "Start": the owner or a person works it, without a lease. */
export async function startTask(
  actor: Actor,
  ref: string,
  input: unknown = {},
) {
  const data = parseTaskInput(ownerVersionSchema, input);
  return ownerChange(actor, ref, data, async (db, task) => {
    if (task.status !== "ready" && task.status !== "triage")
      invalidTransition(task, "started");
    await transition(db, actor, task, "in_progress", {
      sets: {
        status_note: null,
        ...(task.approved_at ? {} : { approved_by_agent_id: actor.agentId }),
      },
      raw: task.approved_at ? [] : ["approved_at = now()"],
    });
  });
}

/**
 * Answers the holder's question: within 7 days the holder gets 30 minutes to
 * resume; later the task returns to the queue with the answer in its history.
 */
export async function answerTask(actor: Actor, ref: string, input: unknown) {
  const data = parseTaskInput(answerSchema, input);
  return ownerChange(actor, ref, data, async (db, task) => {
    if (task.status !== "needs_input") invalidTransition(task, "answered");
    const { rows } = await db.query(
      "SELECT input_requested_at > now() - make_interval(days => $3) AS fresh FROM brain_tasks WHERE owner_id = $1 AND id = $2",
      [actor.ownerId, task.id, ANSWER_RESUME_DAYS],
    );
    const resume = Boolean(rows[0]?.fresh) && task.lease_id !== null;
    if (resume)
      await transition(db, actor, task, "in_progress", {
        action: "answered",
        sets: { status_note: null, input_requested_at: null },
        raw: [
          `lease_expires_at = now() + make_interval(mins => ${LEASE_MINUTES.default})`,
        ],
        note: data.answer,
        payload: {
          resumed: true,
          ...(data.choice ? { choice: data.choice } : {}),
        },
      });
    else
      await transition(
        db,
        actor,
        task,
        await releaseTarget(db, actor.ownerId, task),
        {
          action: "answered",
          sets: { status_note: null, ...CLEARED_LEASE },
          note: data.answer,
          payload: {
            resumed: false,
            ...(data.choice ? { choice: data.choice } : {}),
          },
        },
      );
  });
}

/** "Release" or "Revoke": ends any claim; an on-request claim returns to its start state. */
export async function forceReleaseTask(
  actor: Actor,
  ref: string,
  input: unknown = {},
) {
  const data = parseTaskInput(ownerNoteSchema, input);
  return ownerChange(actor, ref, data, async (db, task) => {
    if (task.status !== "in_progress" && task.status !== "needs_input")
      invalidTransition(task, "released");
    const to = task.lease_id
      ? await releaseTarget(db, actor.ownerId, task)
      : "ready";
    await transition(db, actor, task, to, {
      action: "released",
      sets: { status_note: data.note ?? null, ...CLEARED_LEASE },
      note: data.note ?? null,
      payload: { forced: true, ...(data.note ? { statusNote: true } : {}) },
    });
  });
}

export async function blockTask(actor: Actor, ref: string, input: unknown) {
  const data = parseTaskInput(blockSchema, input);
  return ownerChange(actor, ref, data, async (db, task) => {
    if (
      !["triage", "ready", "in_progress", "needs_input"].includes(task.status)
    )
      invalidTransition(task, "blocked");
    await transition(db, actor, task, "blocked", {
      sets: {
        blocked_reason: data.reason,
        status_note: data.note ?? null,
        ...CLEARED_LEASE,
      },
      note: data.note ?? null,
      payload: {
        blockedReason: data.reason,
        ...(data.note ? { statusNote: true } : {}),
      },
    });
  });
}

export async function unblockTask(
  actor: Actor,
  ref: string,
  input: unknown = {},
) {
  const data = parseTaskInput(ownerVersionSchema, input);
  return ownerChange(actor, ref, data, async (db, task) => {
    if (task.status !== "blocked") invalidTransition(task, "unblocked");
    await transition(db, actor, task, task.approved_at ? "ready" : "triage", {
      sets: { blocked_reason: null, status_note: null },
    });
  });
}

export async function holdTask(actor: Actor, ref: string, input: unknown = {}) {
  const data = parseTaskInput(ownerNoteSchema, input);
  return ownerChange(actor, ref, data, async (db, task) => {
    if (!OPEN.includes(task.status as TaskStatus) || task.status === "on_hold")
      invalidTransition(task, "put on hold");
    await transition(db, actor, task, "on_hold", {
      sets: {
        blocked_reason: null,
        status_note: data.note ?? null,
        ...CLEARED_LEASE,
      },
      note: data.note ?? null,
      payload: data.note ? { statusNote: true } : {},
    });
  });
}

export async function resumeTask(
  actor: Actor,
  ref: string,
  input: unknown = {},
) {
  const data = parseTaskInput(ownerVersionSchema, input);
  return ownerChange(actor, ref, data, async (db, task) => {
    if (task.status !== "on_hold") invalidTransition(task, "resumed");
    await transition(db, actor, task, task.approved_at ? "ready" : "triage", {
      sets: { status_note: null },
    });
  });
}

/** Cancel (or reject a triage item); an extraction rejected here never returns. */
export async function cancelTask(
  actor: Actor,
  ref: string,
  input: unknown = {},
) {
  const data = parseTaskInput(ownerNoteSchema, input);
  return ownerChange(actor, ref, data, async (db, task) => {
    if (!OPEN.includes(task.status as TaskStatus))
      invalidTransition(task, "canceled");
    await transition(db, actor, task, "canceled", {
      sets: {
        blocked_reason: null,
        status_note: data.note ?? null,
        ...CLEARED_LEASE,
      },
      note: data.note ?? null,
      payload: data.note ? { statusNote: true } : {},
    });
    await rememberRejectedExtraction(db, actor.ownerId, task);
  });
}

/** The owner closes any open task directly. */
export async function closeTask(
  actor: Actor,
  ref: string,
  input: unknown = {},
) {
  const data = parseTaskInput(ownerNoteSchema, input);
  return ownerChange(actor, ref, data, async (db, task) => {
    if (!OPEN.includes(task.status as TaskStatus))
      invalidTransition(task, "closed");
    await transition(db, actor, task, "done", {
      sets: { blocked_reason: null, status_note: null, ...CLEARED_LEASE },
      raw: ["completed_at = now()"],
      note: data.note ?? null,
    });
    await unblockDependents(db, actor.ownerId, task, actor.agentId);
  });
}

export async function reopenTask(
  actor: Actor,
  ref: string,
  input: unknown = {},
) {
  const data = parseTaskInput(ownerNoteSchema, input);
  return ownerChange(actor, ref, data, async (db, task) => {
    if (task.status !== "done" && task.status !== "canceled")
      invalidTransition(task, "reopened");
    await transition(db, actor, task, task.approved_at ? "ready" : "triage", {
      sets: {
        status_note: data.note ?? null,
        completed_at: null,
        completed_lease_hash: null,
      },
      note: data.note ?? null,
      payload: data.note ? { statusNote: true } : {},
    });
  });
}

/** in_review → done (approve) or ready with a note for the next brief. */
export async function reviewTask(actor: Actor, ref: string, input: unknown) {
  const data = parseTaskInput(reviewSchema, input);
  return ownerChange(actor, ref, data, async (db, task) => {
    if (task.status !== "in_review") invalidTransition(task, "reviewed");
    if (data.decision === "approve") {
      await transition(db, actor, task, "done", {
        action: "reviewed",
        raw: ["completed_at = now()"],
        note: data.note ?? null,
        payload: { decision: "approve" },
      });
      await unblockDependents(db, actor.ownerId, task, actor.agentId);
    } else
      await transition(db, actor, task, "ready", {
        action: "reviewed",
        sets: { status_note: data.note ?? null, completed_lease_hash: null },
        note: data.note ?? null,
        payload: { decision: "request_changes", statusNote: true },
      });
  });
}

export async function archiveTask(
  actor: Actor,
  ref: string,
  archived: boolean,
  input: unknown = {},
) {
  const data = parseTaskInput(ownerVersionSchema, input);
  return ownerChange(actor, ref, data, async (db, task) => {
    if (archived && task.lease_id)
      throw taskError(
        "INVALID_TRANSITION",
        `${task.ref} is claimed.`,
        "Release or cancel it before archiving.",
      );
    if (Boolean(task.archived_at) === archived) return;
    await updateTaskRow(db, actor.ownerId, task.id, {}, [
      archived ? "archived_at = now()" : "archived_at = NULL",
      "version = version + 1",
    ]);
    await recordEvent(db, {
      ownerId: actor.ownerId,
      taskId: task.id,
      actorAgentId: actor.agentId,
      action: "edited",
      payload: { changedFields: ["archived"], archived },
    });
  });
}

/**
 * Purge deletes the task with its events, links and parties, leaving only a
 * text-free `purged` event with the number and the owner as actor.
 */
export async function purgeTask(actor: Actor, ref: string) {
  assertOwnerActor(actor);
  return transaction(async (db) => {
    const task = await lockTask(db, actor.ownerId, ref);
    await rememberRejectedExtraction(db, actor.ownerId, task);
    // The delete cascades to its dependency edges; tasks it alone kept
    // blocked go back to ready, as when a dependency is removed.
    const dependents = await lockDependencyBlockedDependents(
      db,
      actor.ownerId,
      task.id,
    );
    await db.query("DELETE FROM brain_tasks WHERE owner_id = $1 AND id = $2", [
      actor.ownerId,
      task.id,
    ]);
    if (dependents.length)
      await releaseDependencyBlocks(
        db,
        actor.ownerId,
        dependents,
        actor.agentId,
        { cause: "dependencies_removed", removed: task.ref },
      );
    await recordEvent(db, {
      ownerId: actor.ownerId,
      taskId: null,
      actorAgentId: actor.agentId,
      action: "purged",
      payload: { number: task.number },
    });
    return { ref: task.ref, purged: true };
  });
}
