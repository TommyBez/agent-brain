import type { Evaluate, Question } from "../consolidator/types";
import type { ExtractedItem } from "./extract";
import { TASK_KEEPER_THRESHOLDS } from "./policy";
import { keeperQuestion } from "./prompts";
import { askAll, probability } from "./screen";
import type { KeeperSnapshot } from "./snapshot";

// Step 4: Jev verification per item. A non-explicit commitment or an item the
// source gives as done yields no task; unsupported actors and due fields are
// dropped (the due date falls back to unset), never guessed.

export type DueKind = "unset" | "date" | "approximate" | "event";

export interface VerifiedItem extends ExtractedItem {
  dueKind: DueKind;
}

export type Verification =
  | {
      status: "accepted";
      item: VerifiedItem;
      dropped: ("actors" | "dueText" | "dueDate")[];
      probabilities: Record<string, number>;
    }
  | {
      status: "not_commitment" | "already_done";
      probabilities: Record<string, number>;
    };

// "alla prossima riunione", "next call", "entro il prossimo SAL" …
const EVENT_WORDING =
  /\b(riunion|incontr|meeting|call|chiamat|sal\b|stand-?up|sync|retro|review|comitato|steering|assemblea|consiglio|demo|kick-?off|workshop|prossima volta|next time)/i;

export function dueKindFor(item: {
  dueText: string | null;
  dueDate: string | null;
}): DueKind {
  if (item.dueDate) return "date";
  if (!item.dueText) return "unset";
  return EVENT_WORDING.test(item.dueText) ? "event" : "approximate";
}

export function verificationState(
  snapshot: KeeperSnapshot,
  item: ExtractedItem,
) {
  const units = item.passages.map((index) => snapshot.units[index]);
  return {
    source: {
      title: snapshot.page.title,
      type: snapshot.page.type,
      headings: [...new Set(units.flatMap((unit) => unit.headings))],
      passages: units.map((unit) => unit.text),
    },
    item: {
      title: item.title,
      actorNames: item.actorNames,
      dueText: item.dueText,
      dueDate: item.dueDate,
    },
  };
}

export async function verifyItem(
  snapshot: KeeperSnapshot,
  item: ExtractedItem,
  evaluate: Evaluate,
): Promise<Verification> {
  const questions: Record<string, Question> = {
    explicit_commitment: keeperQuestion("explicit_commitment"),
    already_done: keeperQuestion("already_done"),
  };
  if (item.actorNames.length)
    questions.actor_supported = keeperQuestion("actor_supported");
  if (item.dueText)
    questions.due_text_supported = keeperQuestion("due_text_supported");
  if (item.dueDate)
    questions.due_date_supported = keeperQuestion("due_date_supported");
  const answers = await askAll(
    verificationState(snapshot, item),
    questions,
    evaluate,
  );
  const probabilities = Object.fromEntries(
    Object.keys(questions).map((id) => [id, probability(answers[id])]),
  );
  const t = TASK_KEEPER_THRESHOLDS;
  if (probabilities.explicit_commitment < t.explicitCommitment)
    return { status: "not_commitment", probabilities };
  if (probabilities.already_done >= t.alreadyDone)
    return { status: "already_done", probabilities };
  const dropped: ("actors" | "dueText" | "dueDate")[] = [];
  const verified: VerifiedItem = { ...item, dueKind: "unset" };
  if (
    item.actorNames.length &&
    probabilities.actor_supported < t.actorSupported
  ) {
    verified.actorNames = [];
    dropped.push("actors");
  }
  if (item.dueText && probabilities.due_text_supported < t.dueSupported) {
    verified.dueText = null;
    dropped.push("dueText");
  }
  if (item.dueDate && probabilities.due_date_supported < t.dueSupported) {
    verified.dueDate = null;
    dropped.push("dueDate");
  }
  verified.dueKind = dueKindFor(verified);
  return { status: "accepted", item: verified, dropped, probabilities };
}
