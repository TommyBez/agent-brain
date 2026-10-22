import { TASK_DUE_KINDS, type TaskDueKind } from "@/lib/tasks/types";
import { ownerWallTime, ownerWallToIso } from "./labels";

// The typed due date of the task form: a kind, a date and time on the
// owner's clock, and the original wording.

export interface StoredDue {
  kind: string;
  on: string | null;
  at: string | null;
  text: string | null;
}

export interface DueState {
  kind: TaskDueKind;
  date: string;
  time: string;
  text: string;
}

export function initialDue(due?: StoredDue | null): DueState {
  const wall = due?.at ? ownerWallTime(due.at) : null;
  return {
    kind: (TASK_DUE_KINDS as readonly string[]).includes(due?.kind ?? "")
      ? (due?.kind as TaskDueKind)
      : "unset",
    date: wall?.date ?? due?.on ?? "",
    time: wall?.time ?? "",
    text: due?.text ?? "",
  };
}

/** The typed due date for the service, or a message when it is incomplete. */
export function dueInput(
  state: DueState,
): { due: Record<string, string> } | { error: string } {
  const text = state.text.trim();
  const base = { kind: state.kind, ...(text ? { text } : {}) };
  switch (state.kind) {
    case "unset":
      return { due: { kind: "unset" } };
    case "date":
      return state.date
        ? { due: { ...base, on: state.date } }
        : { error: "Choose the due date." };
    case "datetime":
      return state.date && state.time
        ? { due: { ...base, at: ownerWallToIso(state.date, state.time) } }
        : { error: "Choose the due date and time." };
    case "approximate":
    case "event":
      return text
        ? { due: { ...base, ...(state.date ? { on: state.date } : {}) } }
        : {
            error:
              state.kind === "event"
                ? "Name the event, e.g. “next steering meeting”."
                : "Write the approximate wording, e.g. “end of October”.",
          };
    case "hard":
      if (!state.date) return { error: "Choose the deadline." };
      return {
        due: state.time
          ? { ...base, at: ownerWallToIso(state.date, state.time) }
          : { ...base, on: state.date },
      };
  }
}
