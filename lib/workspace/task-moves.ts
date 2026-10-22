import { statusLabel } from "@/components/tasks/labels";
import {
  boardMove,
  isBlockedReason,
  type OwnerMoveOp,
  type SeenTask,
  suggestedTransition,
  suggestionConflict,
  type TaskChange,
  type TaskOperation,
  taskChange,
} from "@/components/tasks/transitions";
import { BrainError } from "@/lib/brain/types";
import { transaction } from "@/lib/db";
import type { Actor } from "@/lib/tasks/actors";
import { parseTaskInput, taskError } from "@/lib/tasks/errors";
import {
  answerTask,
  approveTask,
  archiveTask,
  blockTask,
  cancelTask,
  closeTask,
  delegateTask,
  forceReleaseTask,
  holdTask,
  reopenTask,
  resumeTask,
  reviewTask,
  startTask,
  unblockTask,
} from "@/lib/tasks/owner";
import { iso } from "@/lib/tasks/records";
import { delegateSchema, type OwnerFence } from "@/lib/tasks/schemas";
import { updateTask } from "@/lib/tasks/service";
import { addTaskLink, decideTaskSuggestion } from "@/lib/tasks/suggestions";
import { TASK_STATUSES, type TaskStatus } from "@/lib/tasks/types";
import {
  queryActiveAgent,
  querySuggestion,
  queryTaskState,
  type TaskState,
} from "./task-queries";

// The owner's Server Actions, without the session: each checks that the task
// is still what the owner's screen showed before it runs an owner power.
// Version never moves with claims, renewals or questions (§5), so the screen
// also sends the claim count and the question time it showed. The early
// check names what changed; the owner power checks the same fence again
// under its row lock, so a claim committed in between is refused too.

export type { TaskOperation };

export interface TaskOperationInput {
  expectedVersion?: number;
  /** The claim the screen showed; a takeover or a new claim is a conflict. */
  claimCount?: number;
  /** The question the screen showed; a newer question is a conflict. */
  inputRequestedAt?: string | null;
  note?: string;
  reason?: string;
  answer?: string;
  choice?: string;
}

const text = (value: unknown, max = 4_000) =>
  typeof value === "string" && value.trim() ? value.slice(0, max) : undefined;
export const positiveVersion = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : undefined;
const claimCount = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
const instant = (value: unknown) =>
  value === null ? null : typeof value === "string" ? value : undefined;

/** The fence a client sent, keeping only well-formed values. */
export function seenTask(input: unknown): SeenTask {
  const value = (input ?? {}) as Record<string, unknown>;
  return {
    ...(typeof value.status === "string" &&
    (TASK_STATUSES as readonly string[]).includes(value.status)
      ? { status: value.status }
      : {}),
    version: positiveVersion(value.version ?? value.expectedVersion),
    claimCount: claimCount(value.claimCount),
    inputRequestedAt: instant(value.inputRequestedAt),
  };
}

const CHANGE_TEXT: Record<TaskChange, (current: TaskState) => string> = {
  status: (current) => `it is ${statusLabel(current.status)} now`,
  version: (current) =>
    `it was edited (it is ${statusLabel(current.status)}, version ${current.version})`,
  claim: (current) =>
    current.holder ? `${current.holder} claimed it` : "its claim changed",
  question: () => "its holder asked a new question",
};

function taskChanged(current: TaskState, change: TaskChange, since: string) {
  return taskError(
    "TASK_VERSION_CONFLICT",
    `${current.ref} changed since ${since}: ${CHANGE_TEXT[change](current)}.`,
    "Load the latest version, then decide again.",
    { ref: current.ref, change },
  );
}

/** Refuses when the committed task differs from what the screen showed. */
async function assertUnchanged(
  ownerId: string,
  ref: string,
  seen: SeenTask,
  since = "you loaded it",
): Promise<TaskState> {
  const current = await queryTaskState(ownerId, ref);
  const change = taskChange(current, seen);
  if (change) throw taskChanged(current, change, since);
  return current;
}

function ownerOperation(
  actor: Actor,
  target: string,
  operation: TaskOperation,
  input: TaskOperationInput,
) {
  const seen = seenTask(input);
  const fence: OwnerFence = {
    expectedVersion: positiveVersion(input.expectedVersion),
    ...(seen.claimCount !== undefined
      ? { expectedClaimCount: seen.claimCount }
      : {}),
    ...(seen.inputRequestedAt !== undefined
      ? { expectedInputRequestedAt: seen.inputRequestedAt }
      : {}),
  };
  const note = text(input.note, 2_000);
  const withNote = { ...fence, ...(note ? { note } : {}) };
  switch (operation) {
    case "approve":
      return approveTask(actor, target, fence);
    case "reject":
    case "cancel":
      return cancelTask(actor, target, withNote);
    case "start":
      return startTask(actor, target, fence);
    case "hold":
      return holdTask(actor, target, withNote);
    case "resume":
      return resumeTask(actor, target, fence);
    case "release":
      return forceReleaseTask(actor, target, withNote);
    case "block":
      if (!isBlockedReason(input.reason))
        throw new BrainError("INVALID_INPUT", "Choose why it is blocked.", 400);
      return blockTask(actor, target, { ...withNote, reason: input.reason });
    case "unblock":
      return unblockTask(actor, target, fence);
    case "close":
      return closeTask(actor, target, withNote);
    case "reopen":
      return reopenTask(actor, target, withNote);
    case "review_approve":
      return reviewTask(actor, target, { ...withNote, decision: "approve" });
    case "request_changes":
      return reviewTask(actor, target, {
        ...withNote,
        decision: "request_changes",
      });
    case "answer": {
      const choice = text(input.choice, 200);
      const answer = text(input.answer) ?? choice;
      return answerTask(actor, target, {
        ...fence,
        answer,
        ...(choice ? { choice } : {}),
      });
    }
    case "archive":
    case "unarchive":
      return archiveTask(actor, target, operation === "archive", fence);
    default:
      throw new BrainError("INVALID_INPUT", "Unknown task operation.", 400);
  }
}

/**
 * One owner transition. With a claim count or a question time, the task must
 * still show that claim and that question: Release, Revoke and an answer
 * never reach a claim or a question the owner did not see.
 */
export async function runTaskOperation(
  actor: Actor,
  ref: string,
  operation: TaskOperation,
  input: TaskOperationInput = {},
) {
  const seen = seenTask(input);
  if (seen.claimCount !== undefined || seen.inputRequestedAt !== undefined)
    await assertUnchanged(actor.ownerId, ref, seen);
  return ownerOperation(actor, ref, operation, input);
}

const MOVE_OPERATION: Record<OwnerMoveOp, TaskOperation> = {
  approve: "approve",
  start: "start",
  hold: "hold",
  resume: "resume",
  release: "release",
  block: "block",
  unblock: "unblock",
  close: "close",
  review_approve: "review_approve",
  request_changes: "request_changes",
  reopen: "reopen",
  cancel: "cancel",
};

/**
 * A board move. The operation is derived again from the committed state; a
 * task whose status, version or claim changed since the board loaded is a
 * conflict, so a drag never ends a claim the owner did not see.
 */
export async function moveTask(
  actor: Actor,
  ref: string,
  from: string,
  to: string,
  input: TaskOperationInput = {},
) {
  const current = await assertUnchanged(
    actor.ownerId,
    ref,
    { ...seenTask(input), inputRequestedAt: undefined, status: from },
    "the board loaded",
  );
  const op = (TASK_STATUSES as readonly string[]).includes(to)
    ? boardMove(current, to as TaskStatus)
    : null;
  if (!op)
    throw taskError(
      "INVALID_TRANSITION",
      `${current.ref} cannot move from ${statusLabel(current.status)} to ${statusLabel(to)}.`,
      "Load the latest version and choose a column the task can move to.",
    );
  return ownerOperation(actor, current.ref, MOVE_OPERATION[op], {
    ...input,
    inputRequestedAt: undefined,
    expectedVersion: current.version,
  });
}

/**
 * Accepts a task keeper suggestion and runs its prefilled transition as the
 * owner. Under the task's row lock the suggestion must still apply (a stale
 * claim: same holder, same lease, still expired); otherwise it is closed as
 * expired and the owner gets a conflict. The task must also be the one the
 * card showed; the transition then runs fenced by that version.
 */
export async function acceptSuggestion(
  actor: Actor,
  id: string,
  seen: SeenTask = {},
): Promise<{ ref: string; ran: string | null }> {
  const suggestion = await querySuggestion(actor.ownerId, id);
  if (!suggestion)
    throw taskError(
      "SUGGESTION_NOT_FOUND",
      "That suggestion is not open.",
      "Reload Needs you; it may have been decided or expired.",
    );
  const transition = suggestedTransition(suggestion);
  if (transition?.op === "link")
    await addTaskLink(actor, suggestion.ref, {
      pageRef: transition.pageRef,
      role: transition.role,
    });
  else if (transition) {
    const op = transition.op;
    const checked = await transaction(async (db) => {
      // The lease expiry as the stale claim records it (task-keeper/hygiene.ts).
      const { rows } = await db.query(
        `SELECT t.status, t.version, t.claim_count, t.claimed_by_agent_id,
           t.lease_expires_at,
           to_char(t.lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS lease_expiry,
           t.input_requested_at, t.approved_at IS NOT NULL AS approved,
           t.lease_id IS NOT NULL AS leased,
           coalesce(t.lease_expires_at > now(), false) AS lease_live,
           t.archived_at IS NOT NULL AS archived,
           (SELECT a.label FROM brain_agents a
            WHERE a.owner_id = t.owner_id AND a.id = t.claimed_by_agent_id) AS holder
         FROM brain_tasks t WHERE t.owner_id = $1 AND t.id = $2 FOR UPDATE`,
        [actor.ownerId, suggestion.taskId],
      );
      const task = rows[0];
      if (!task) return null;
      const conflict = suggestionConflict(suggestion, op, {
        status: task.status,
        archived: task.archived,
        claimedById: task.claimed_by_agent_id,
        leaseExpiresAt: task.lease_expiry,
        leased: task.leased,
        leaseLive: task.lease_live,
      });
      if (conflict)
        await db.query(
          `UPDATE brain_task_suggestions SET status = 'expired', updated_at = now()
           WHERE owner_id = $1 AND id = $2 AND status = 'open'`,
          [actor.ownerId, suggestion.id],
        );
      const state: TaskState = {
        ref: suggestion.ref,
        status: task.status,
        approved: task.approved,
        version: task.version,
        claimCount: task.claim_count,
        holder: task.holder,
        inputRequestedAt: iso(task.input_requested_at),
      };
      return { conflict, state, leaseExpiresAt: iso(task.lease_expires_at) };
    });
    if (!checked)
      throw taskError(
        "SUGGESTION_NOT_FOUND",
        "That suggestion is not open.",
        "Reload Needs you; its task was deleted.",
      );
    if (checked.conflict)
      throw taskError(
        "TASK_VERSION_CONFLICT",
        `${suggestion.ref} ${checked.conflict}, so the suggestion no longer applies; it was closed.`,
        "Load the latest version of Needs you.",
        { ref: suggestion.ref },
      );
    const change = taskChange(checked.state, {
      ...seen,
      inputRequestedAt: undefined,
    });
    if (change)
      throw taskChanged(checked.state, change, "this suggestion was shown");
    // The transition locks the task again: the claim it saw must still be
    // there, and a stale claim must not have been renewed meanwhile.
    const fenced = {
      expectedVersion: checked.state.version,
      expectedClaimCount: checked.state.claimCount,
      ...(suggestion.kind === "stale_claim"
        ? { expectedLeaseExpiresAt: checked.leaseExpiresAt }
        : {}),
      ...(transition.note ? { note: transition.note } : {}),
    };
    if (op === "close") await closeTask(actor, suggestion.ref, fenced);
    if (op === "cancel") await cancelTask(actor, suggestion.ref, fenced);
    if (op === "release") await forceReleaseTask(actor, suggestion.ref, fenced);
    if (op === "hold") await holdTask(actor, suggestion.ref, fenced);
  }
  try {
    await decideTaskSuggestion(actor, {
      id: suggestion.id,
      decision: "accepted",
    });
  } catch (error) {
    // The transition ran; a suggestion closed meanwhile (the nightly expiry)
    // needs no second decision.
    if (
      !transition ||
      !(error instanceof BrainError) ||
      error.code !== "SUGGESTION_NOT_FOUND"
    )
      throw error;
  }
  return { ref: suggestion.ref, ran: transition?.op ?? null };
}

/**
 * Saves the changed fields, then the delegate (a separate owner power). The
 * delegate is checked first, so an agent disabled meanwhile fails the edit
 * before anything is written.
 */
export async function saveTaskEdits(
  actor: Actor,
  ref: string,
  expectedVersion: unknown,
  patch: Record<string, unknown>,
  delegate?: { agentId: string | null },
) {
  let current = positiveVersion(expectedVersion);
  if (delegate) {
    const data = parseTaskInput(delegateSchema, {
      agentId: delegate.agentId,
    });
    if (data.agentId && !(await queryActiveAgent(actor.ownerId, data.agentId)))
      throw taskError(
        "AGENT_NOT_FOUND",
        "That agent is not an active connected agent.",
        "Choose an agent from the /agents registry.",
      );
  }
  if (Object.keys(patch ?? {}).length)
    current = (
      await updateTask(actor, { ref, expectedVersion: current, patch })
    ).task.version;
  if (delegate)
    await delegateTask(actor, ref, {
      expectedVersion: current,
      agentId: delegate.agentId,
    });
  return ref;
}
