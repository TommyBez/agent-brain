import { BrainError } from "../../brain/types";
import { getPool } from "../../db";
import type { Actor } from "../../tasks/actors";
import {
  addDays,
  nextAtValue,
  nextOccurrence,
  occurrencesBetween,
  parseRecurrenceRule,
  type RecurrenceRule,
  type RecurrenceTemplate,
  recurrenceTemplateSchema,
} from "../../tasks/recurrences";
import { createTask } from "../../tasks/service";
import { TASK_KEEPER_LIMITS } from "./policy";

// Step (4) of §8.5: one `ready` instance per occurrence of a `task` series,
// created by the task keeper (never the conciliator). next_at is the series'
// watermark: the next occurrence not yet instantiated. Paused series are
// skipped; resuming moves the watermark past the paused period. A `meeting`
// series only has its next meeting date refreshed.

export interface RecurrenceRunResult {
  /** Instances created this run. */
  occurrences: number;
  /** Instances that already existed (a replayed step or night). */
  existing: number;
  /** Older missed occurrences skipped beyond the per-series cap. */
  skipped: number;
  /** Series whose rule or template no longer parses. */
  invalid: number;
}

/** Occurrences due for instantiation and the next watermark. Pure. */
export function pendingOccurrences(
  rule: RecurrenceRule,
  watermark: string | null,
  runDate: string,
  leadDays: number,
) {
  const horizon = addDays(runDate, leadDays);
  const from = watermark ?? nextOccurrence(rule, runDate);
  if (!from) return { dates: [], skipped: 0, next: null };
  const due = occurrencesBetween(rule, from, horizon);
  const keep = due.slice(-TASK_KEEPER_LIMITS.occurrencesPerSeries);
  const next = due.length ? nextOccurrence(rule, addDays(horizon, 1)) : from;
  return { dates: keep, skipped: due.length - keep.length, next };
}

function code(error: unknown) {
  return error instanceof BrainError ? error.code : null;
}

async function createInstance(
  actor: Actor,
  series: { id: string; projectId: string | null },
  template: RecurrenceTemplate,
  date: string,
) {
  const input = (projectId: string | null) => ({
    origin: "recurrence" as const,
    recurrenceId: series.id,
    occurrenceOn: date,
    title: template.title,
    ...(template.description ? { description: template.description } : {}),
    ...(template.acceptanceCriteria?.length
      ? { acceptanceCriteria: template.acceptanceCriteria }
      : {}),
    ...(template.priority !== undefined ? { priority: template.priority } : {}),
    ...(template.expectedOutput
      ? { expectedOutput: template.expectedOutput }
      : {}),
    ...(projectId ? { projectRef: projectId } : {}),
    ...(template.dueOnOccurrence === false
      ? {}
      : { due: { kind: "date" as const, on: date } }),
  });
  try {
    return await createTask(actor, input(series.projectId));
  } catch (error) {
    // The series' page is no longer a project: create the instance without it.
    if (code(error) !== "PROJECT_NOT_FOUND" || !series.projectId) throw error;
    return createTask(actor, input(null));
  }
}

export async function instantiateRecurrences(
  actor: Actor,
  runDate: string,
): Promise<RecurrenceRunResult> {
  const ownerId = actor.ownerId;
  const result: RecurrenceRunResult = {
    occurrences: 0,
    existing: 0,
    skipped: 0,
    invalid: 0,
  };
  const { rows } = await getPool().query(
    `SELECT id, kind, template, rrule, project_page_id,
       to_char(next_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS next_on, next_at
     FROM brain_task_recurrences
     WHERE owner_id = $1 AND paused_at IS NULL
     ORDER BY created_at, id`,
    [ownerId],
  );
  for (const row of rows) {
    let rule: RecurrenceRule;
    let template: RecurrenceTemplate;
    try {
      rule = parseRecurrenceRule(row.rrule);
      template = recurrenceTemplateSchema.parse(row.template);
    } catch {
      result.invalid++;
      continue;
    }
    let next: string | null;
    if (row.kind === "meeting") next = nextOccurrence(rule, runDate);
    else {
      const pending = pendingOccurrences(
        rule,
        row.next_on,
        runDate,
        template.leadDays ?? 0,
      );
      result.skipped += pending.skipped;
      for (const date of pending.dates) {
        const created = await createInstance(
          actor,
          { id: row.id, projectId: row.project_page_id },
          template,
          date,
        );
        if (created.replayed) result.existing++;
        else result.occurrences++;
      }
      next = pending.next;
    }
    if (next !== row.next_on)
      // Compare-and-swap: an owner edit since the read keeps its watermark.
      await getPool().query(
        `UPDATE brain_task_recurrences SET next_at = $3
         WHERE owner_id = $1 AND id = $2 AND paused_at IS NULL
           AND next_at IS NOT DISTINCT FROM $4::timestamptz`,
        [ownerId, row.id, nextAtValue(next), row.next_at],
      );
  }
  return result;
}
