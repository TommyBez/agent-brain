import {
  OPEN_TASK_STATUSES,
  TASK_BLOCKED_REASONS,
  TASK_LINK_ROLES,
  type TaskBlockedReason,
  type TaskStatus,
} from "@/lib/tasks/types";
import { statusLabel } from "./labels";

// Which owner operation a board move or an accepted suggestion stands for.
// Pure functions shared by the board, the "Move to…" menu and the Server
// Action, so the client never offers a move the server would refuse.

export type OwnerMoveOp =
  | "approve"
  | "start"
  | "hold"
  | "resume"
  | "release"
  | "block"
  | "unblock"
  | "close"
  | "review_approve"
  | "request_changes"
  | "reopen"
  | "cancel";

/** Every owner transition the app runs on one task. */
export type TaskOperation =
  | OwnerMoveOp
  | "reject"
  | "answer"
  | "archive"
  | "unarchive";

export interface MovableTask {
  status: TaskStatus | string;
  approved: boolean;
}

/** Board columns, in order. Canceling has no column. */
export const BOARD_COLUMNS: readonly TaskStatus[] = [
  "triage",
  "ready",
  "in_progress",
  "needs_input",
  "blocked",
  "in_review",
  "on_hold",
  "done",
];

/** Targets of a card's keyboard "Move to…" menu: every column, plus Canceled. */
export const MENU_TARGETS: readonly TaskStatus[] = [
  ...BOARD_COLUMNS,
  "canceled",
];

/** Moves that need more input from the owner before they run. */
export const MOVE_INPUT: Partial<Record<OwnerMoveOp, "reason" | "note">> = {
  block: "reason",
  request_changes: "note",
};

const isOpen = (status: string) =>
  (OPEN_TASK_STATUSES as readonly string[]).includes(status);

/** The owner operation behind moving a task to `to`, or null when there is none. */
export function boardMove(
  task: MovableTask,
  to: TaskStatus,
): OwnerMoveOp | null {
  const from = task.status;
  if (from === to) return null;
  // The state a task returns to when it leaves work: ready once approved.
  const queue: TaskStatus = task.approved ? "ready" : "triage";
  switch (to) {
    case "ready":
    case "triage":
      if (from === "triage" && to === "ready") return "approve";
      if (from === "on_hold" && to === queue) return "resume";
      if (from === "blocked" && to === queue) return "unblock";
      if (from === "in_review" && to === "ready") return "request_changes";
      if (from === "done" || from === "canceled")
        return to === queue ? "reopen" : null;
      // An on-request claim of an unapproved task returns where it started.
      if (from === "in_progress" || from === "needs_input")
        return to === queue || (!task.approved && to === "ready")
          ? "release"
          : null;
      return null;
    case "in_progress":
      return from === "ready" || from === "triage" ? "start" : null;
    case "blocked":
      return ["triage", "ready", "in_progress", "needs_input"].includes(from)
        ? "block"
        : null;
    case "on_hold":
      return isOpen(from) ? "hold" : null;
    case "done":
      if (from === "in_review") return "review_approve";
      return isOpen(from) ? "close" : null;
    case "canceled":
      return isOpen(from) ? "cancel" : null;
    default:
      // needs_input and in_review belong to the holder's protocol.
      return null;
  }
}

export function boardMoveTargets(
  task: MovableTask,
  statuses: readonly TaskStatus[],
): { status: TaskStatus; op: OwnerMoveOp }[] {
  return statuses.flatMap((status) => {
    const op = boardMove(task, status);
    return op ? [{ status, op }] : [];
  });
}

export function isBlockedReason(value: unknown): value is TaskBlockedReason {
  return (
    typeof value === "string" &&
    (TASK_BLOCKED_REASONS as readonly string[]).includes(value)
  );
}

/**
 * A transition a task keeper suggestion prefills. Accepting runs it as the
 * owner; anything not listed here only records the decision.
 */
export type SuggestedTransition =
  | { op: "close" | "cancel" | "release" | "hold"; note?: string }
  | {
      op: "link";
      pageRef: string;
      role: "context" | "decision" | "stakeholder" | "source";
    };

const OP_ALIASES: Record<string, "close" | "cancel" | "release" | "hold"> = {
  close: "close",
  done: "close",
  complete: "close",
  cancel: "cancel",
  canceled: "cancel",
  cancelled: "cancel",
  release: "release",
  revoke: "release",
  hold: "hold",
  on_hold: "hold",
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : undefined;

function citedPage(citations: unknown): string | undefined {
  if (!Array.isArray(citations)) return undefined;
  for (const citation of citations) {
    const item = record(citation);
    const page = text(item?.pageId ?? item?.pageRef ?? item?.slug, 220);
    if (page) return page;
  }
  return undefined;
}

/**
 * Reads the prefilled transition of a suggestion: `payload.transition` (or the
 * payload itself) naming `op`/`action`/`to`. Stale claims default to a release
 * and new sources to a source link to the cited page.
 */
export function suggestedTransition(suggestion: {
  kind: string;
  payload: unknown;
  citations?: unknown;
}): SuggestedTransition | null {
  const payload = record(suggestion.payload) ?? {};
  const raw = record(payload.transition) ?? payload;
  const name = text(raw.op ?? raw.action ?? raw.to ?? raw.status, 40);
  const note = text(raw.note ?? raw.reason, 2_000);
  if (name && OP_ALIASES[name.toLowerCase()])
    return { op: OP_ALIASES[name.toLowerCase()], ...(note ? { note } : {}) };
  const role = text(raw.role, 20);
  const pageRef = text(raw.pageRef ?? raw.pageId ?? raw.page, 220);
  if (
    name &&
    ["link", "add_link"].includes(name.toLowerCase()) &&
    pageRef &&
    role &&
    (TASK_LINK_ROLES as readonly string[]).includes(role) &&
    role !== "produced"
  )
    return {
      op: "link",
      pageRef,
      role: role as "context" | "decision" | "stakeholder" | "source",
    };
  if (suggestion.kind === "stale_claim") return { op: "release" };
  if (suggestion.kind === "new_source") {
    const page = pageRef ?? citedPage(suggestion.citations);
    if (page) return { op: "link", pageRef: page, role: "source" };
  }
  return null;
}

/** What the owner's screen showed of a task when they chose an action. */
export interface SeenTask {
  status?: string;
  version?: number;
  /** Claims taken so far: a takeover or a new claim changes it, a renewal does not. */
  claimCount?: number;
  /** When the open question was asked: a second question changes it. */
  inputRequestedAt?: string | null;
}

export interface CommittedTask {
  status: string;
  version: number;
  claimCount: number;
  inputRequestedAt: string | null;
}

export type TaskChange = "status" | "version" | "claim" | "question";

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const left = Date.parse(a);
  const right = Date.parse(b);
  return !Number.isNaN(left) && left === right;
}

/**
 * How the committed task differs from what the owner saw, or null. Version
 * never moves with claims (§5), so the claim count and the question time
 * stand for the claim and the question the owner was looking at.
 */
export function taskChange(
  current: CommittedTask,
  seen: SeenTask,
): TaskChange | null {
  if (seen.status !== undefined && current.status !== seen.status)
    return "status";
  if (seen.version !== undefined && current.version !== seen.version)
    return "version";
  if (seen.claimCount !== undefined && current.claimCount !== seen.claimCount)
    return "claim";
  if (
    seen.inputRequestedAt !== undefined &&
    !sameInstant(current.inputRequestedAt, seen.inputRequestedAt)
  )
    return "question";
  return null;
}

/** The task as an accepted suggestion is checked against, under its row lock. */
export interface LockedSuggestionTask {
  status: string;
  archived: boolean;
  claimedById: string | null;
  /** UTC with microseconds, as the stale claim records it: 2026-10-21T02:00:00.123456Z. */
  leaseExpiresAt: string | null;
  leased: boolean;
  leaseLive: boolean;
}

function transitionAllowed(
  op: "close" | "cancel" | "release" | "hold",
  status: string,
): boolean {
  if (op === "release")
    return status === "in_progress" || status === "needs_input";
  if (op === "hold") return isOpen(status) && status !== "on_hold";
  return isOpen(status);
}

/**
 * Why a suggestion's prefilled transition no longer fits the task, or null.
 * A stale claim applies only to the episode it saw: the same holder's lease,
 * still expired at the same instant. A renewal, a takeover or a new claim
 * each set a new expiry.
 */
export function suggestionConflict(
  suggestion: { kind: string; payload: unknown },
  op: "close" | "cancel" | "release" | "hold",
  task: LockedSuggestionTask,
): string | null {
  if (task.archived) return "was archived";
  if (!transitionAllowed(op, task.status))
    return `is ${statusLabel(task.status)} now`;
  if (suggestion.kind !== "stale_claim") return null;
  if (!task.leased) return "is no longer claimed";
  const payload = record(suggestion.payload);
  const holder = payload?.holderAgentId;
  if (typeof holder === "string" && task.claimedById !== holder)
    return "was taken over by another agent";
  if (task.status === "needs_input")
    return "is waiting for your answer to its holder's question";
  if (task.leaseLive) return "has a live claim again: its holder renewed it";
  const expiredAt = payload?.leaseExpiredAt;
  const expiry = task.leaseExpiresAt;
  if (
    typeof expiredAt === "string" &&
    expiredAt !== expiry &&
    // Second precision, as older keys recorded it.
    expiredAt !== expiry?.replace(/\.\d+Z$/, "Z")
  )
    return "was claimed again";
  return null;
}

/** The screen reader's news after a move: where the server put the task. */
export function moveAnnouncement(
  ref: string,
  requested: TaskStatus,
  actual: string,
): string {
  return actual === requested
    ? `${ref} moved to ${statusLabel(actual)}.`
    : `${ref} returned to ${statusLabel(actual)}, where its claim started.`;
}
