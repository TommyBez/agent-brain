import { format, parseISO } from "date-fns";
import type {
  TaskBlockedReason,
  TaskDueKind,
  TaskExpectedOutput,
  TaskLinkOrigin,
  TaskLinkRole,
  TaskOrigin,
  TaskStatus,
  TaskSuggestionKind,
} from "@/lib/tasks/types";

// Interface copy for the task vocabulary. The app speaks English; task text
// keeps the owner's language.

export const STATUS_LABELS: Record<TaskStatus, string> = {
  triage: "Triage",
  ready: "Ready",
  in_progress: "In progress",
  needs_input: "Needs input",
  blocked: "Blocked",
  in_review: "In review",
  on_hold: "On hold",
  done: "Done",
  canceled: "Canceled",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status as TaskStatus] ?? status.replaceAll("_", " ");
}

export const PRIORITY_LABELS = ["Urgent", "High", "Normal", "Low"] as const;

export function priorityLabel(priority: number): string {
  return PRIORITY_LABELS[priority] ?? "Normal";
}

export const BLOCKED_REASON_LABELS: Record<TaskBlockedReason, string> = {
  dependency: "Waiting on another task",
  external: "Waiting on someone else",
  human_step: "Needs a person",
  decision: "Waiting on a decision",
};

export const ORIGIN_LABELS: Record<TaskOrigin, string> = {
  owner_ui: "created in the app",
  owner_request: "owner request",
  owner_plan: "owner plan",
  subtask: "subtask",
  handoff: "handoff",
  extracted: "extracted from a source",
  recurrence: "recurring",
};

export const EXPECTED_OUTPUT_LABELS: Record<TaskExpectedOutput, string> = {
  none: "Nothing specific",
  decision: "A decision",
  page: "A page in the brain",
  artifact: "An artifact (PR, file, link)",
  external_action: "An action outside the brain",
};

export const LINK_ROLE_LABELS: Record<TaskLinkRole, string> = {
  source: "Sources",
  decision: "Decisions",
  context: "Context",
  stakeholder: "Stakeholders",
  produced: "Produced",
};

export const LINK_ORIGIN_LABELS: Record<TaskLinkOrigin, string> = {
  owner: "You",
  agent: "Agent",
  rule: "Rule",
  provenance: "Verified output",
  consolidator: "Nightly maintenance",
  task_keeper: "Task keeper",
};

export const SUGGESTION_LABELS: Record<TaskSuggestionKind, string> = {
  overdue_no_outcome: "Overdue without an outcome",
  stale_claim: "Stale claim",
  triage_aging: "Waiting in triage for over a week",
  decision_superseded: "A linked decision was superseded",
  new_source: "New source",
  may_be_done: "May already be done",
  criterion_evidence: "Evidence for a criterion",
  divergent_state: "Sources disagree",
  duplicate: "Possible duplicate",
};

export function suggestionLabel(kind: string): string {
  return SUGGESTION_LABELS[kind as TaskSuggestionKind] ?? kind;
}

export const DUE_KIND_LABELS: Record<TaskDueKind, string> = {
  unset: "No due date",
  date: "On a date",
  datetime: "At a date and time",
  approximate: "Approximately",
  event: "At an event",
  hard: "Hard deadline",
};

export interface DueValue {
  kind: string;
  on: string | null;
  at: string | null;
  text: { value: string } | null;
}

/** Due times are the owner's, as in the service's queue order. */
export const OWNER_TIME_ZONE = "Europe/Rome";

const dateTimeFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: OWNER_TIME_ZONE,
});
const dayFormat = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: OWNER_TIME_ZONE,
});

const wallFormat = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: OWNER_TIME_ZONE,
});

/** An instant as the owner's wall clock: YYYY-MM-DD and HH:mm. */
export function ownerWallTime(iso: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    wallFormat
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

const wallMs = (date: string, time: string) => {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return Date.UTC(year, month - 1, day, hour, minute);
};

/** The instant (ISO, UTC) the owner means by a date and time on their clock. */
export function ownerWallToIso(date: string, time: string): string {
  const target = wallMs(date, time);
  let guess = target;
  // Two corrections settle the offset, including across DST changes.
  for (let step = 0; step < 2; step++) {
    const shown = ownerWallTime(new Date(guess).toISOString());
    guess += target - wallMs(shown.date, shown.time);
  }
  return new Date(guess).toISOString();
}

/** The calendar day (YYYY-MM-DD) of a due date, in the owner's time zone. */
export function dueDay(due: { on: string | null; at: string | null }) {
  if (due.on) return due.on;
  return due.at ? dayFormat.format(new Date(due.at)) : null;
}

export function formatDay(day: string): string {
  return format(parseISO(day), "d MMM yyyy");
}

/** The due date as written: original wording first, then the typed date. */
export function dueLabel(due: DueValue): string | null {
  if (due.kind === "unset" && !due.text) return null;
  const typed = due.at
    ? dateTimeFormat.format(new Date(due.at))
    : due.on
      ? formatDay(due.on)
      : null;
  const original = due.text?.value;
  const parts = [original, typed && typed !== original ? typed : null].filter(
    Boolean,
  );
  if (!parts.length) return null;
  return `${due.kind === "hard" ? "Hard deadline: " : ""}${parts.join(" · ")}`;
}

export const EVENT_LABELS: Record<string, string> = {
  created: "created the task",
  edited: "edited the task",
  approved: "approved the task",
  delegated: "changed the delegate",
  status_changed: "changed the status",
  claimed: "claimed the task",
  reported: "reported progress",
  asked: "asked a question",
  answered: "answered",
  released: "released the task",
  completed: "completed the task",
  reviewed: "reviewed the work",
  links_changed: "changed linked knowledge",
  note: "added a note",
  purged: "purged a task",
};
