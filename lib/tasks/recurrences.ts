import { z } from "zod";
import type { Database } from "../brain/pages";
import { BrainError } from "../brain/types";
import { assertOwner } from "../brain/utils";
import { getPool, transaction } from "../db";
import type { Actor } from "./actors";
import { parseTaskInput, taskError } from "./errors";
import { assertOwnerActor } from "./mutations";
import { resolveProject } from "./page-links";
import { iso } from "./records";
import { sanitizeTaskText } from "./sanitize";
import { pageRefSchema, taskLine } from "./schemas";
import {
  TASK_EXPECTED_OUTPUTS,
  TASK_LIMITS,
  TASK_RECURRENCE_KINDS,
  type TaskRecurrenceKind,
} from "./types";

// Owner recurrences (§5.3): a `task` series yields one ready instance per
// occurrence, created by the task keeper; a `meeting` series carries the
// meeting's RRULE and project for the agenda. Supported RRULE subset:
// FREQ=DAILY|WEEKLY|MONTHLY, INTERVAL, BYDAY (ordinals only with MONTHLY),
// COUNT or UNTIL, with a DTSTART line. Occurrences are calendar dates; the
// DTSTART time of day is informational (meeting time).

export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const RECURRENCE_FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY"] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

/** Owner-facing dates and "today" follow the claim queue's time zone. */
export const TASK_TIME_ZONE = "Europe/Rome";

export interface RecurrenceMoment {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, or null for an all-day rule. */
  time: string | null;
  /** The DTSTART/UNTIL value ended in Z. */
  utc: boolean;
}

export interface RecurrenceRule {
  freq: RecurrenceFrequency;
  interval: number;
  /** Ordinal (1..5, -1..-5) only with MONTHLY: "1MO", "-1FR". */
  byDay: { weekday: Weekday; ordinal: number | null }[];
  count: number | null;
  until: RecurrenceMoment | null;
  start: RecurrenceMoment;
}

export const RECURRENCE_LIMITS = {
  interval: 366,
  count: 1000,
  /** Calendar days scanned before giving up (about 100 years). */
  scanDays: 36_600,
  /** Occurrences a single query may return. */
  occurrences: 400,
} as const;

function invalidRule(message: string): never {
  throw taskError(
    "INVALID_RRULE",
    message,
    "Use FREQ=DAILY|WEEKLY|MONTHLY with optional INTERVAL, BYDAY, COUNT or UNTIL, and a start date.",
  );
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/** Days since 1970-01-01 for a YYYY-MM-DD calendar date. */
export function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function dateFromDay(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return dateFromDay(dayNumber(date) + days);
}

/** 0 = Monday … 6 = Sunday. */
function weekdayIndex(day: number): number {
  // 1970-01-01 was a Thursday (index 3).
  return (((day + 3) % 7) + 7) % 7;
}

export function weekdayOf(date: string): Weekday {
  return WEEKDAYS[weekdayIndex(dayNumber(date))];
}

function parseMoment(raw: string, field: string): RecurrenceMoment {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(
    raw.trim(),
  );
  if (!match) invalidRule(`${field} must be YYYYMMDD or YYYYMMDDTHHMMSS[Z].`);
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  if (!validDate(date)) invalidRule(`${field} is not a calendar date.`);
  let time: string | null = null;
  if (match[4] !== undefined) {
    const hours = Number(match[4]);
    const minutes = Number(match[5]);
    if (hours > 23 || minutes > 59 || Number(match[6]) > 59)
      invalidRule(`${field} has an invalid time of day.`);
    time = `${match[4]}:${match[5]}`;
  }
  return { date, time, utc: match[7] === "Z" };
}

function formatMoment(moment: RecurrenceMoment): string {
  const date = moment.date.replaceAll("-", "");
  if (!moment.time) return date;
  return `${date}T${moment.time.replace(":", "")}00${moment.utc ? "Z" : ""}`;
}

/**
 * Parses the stored or submitted rule. `defaults.startsOn` supplies the
 * DTSTART when the text has none (e.g. "FREQ=WEEKLY;BYDAY=TU").
 */
export function parseRecurrenceRule(
  text: string,
  defaults: { startsOn?: string; time?: string | null } = {},
): RecurrenceRule {
  if (typeof text !== "string" || !text.trim())
    invalidRule("The recurrence rule is empty.");
  if (text.length > TASK_LIMITS.rrule)
    invalidRule("The recurrence rule is too long.");
  let start: RecurrenceMoment | null = null;
  let ruleText: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith("DTSTART")) {
      if (start) invalidRule("DTSTART appears more than once.");
      const colon = line.indexOf(":");
      if (colon < 0) invalidRule("DTSTART needs a value.");
      const params = upper.slice("DTSTART".length, colon);
      if (params && !/^(;VALUE=DATE(-TIME)?|;TZID=[^;:]+)*$/.test(params))
        invalidRule("Unsupported DTSTART parameters.");
      start = parseMoment(line.slice(colon + 1), "DTSTART");
    } else {
      if (ruleText !== null) invalidRule("Only one RRULE is supported.");
      ruleText = upper.startsWith("RRULE:") ? line.slice(6) : line;
    }
  }
  if (ruleText === null) invalidRule("The RRULE line is missing.");
  if (!start) {
    if (!defaults.startsOn || !validDate(defaults.startsOn))
      invalidRule("A start date is required.");
    const time = defaults.time ?? null;
    if (time !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
      invalidRule("The time of day must be HH:MM.");
    start = { date: defaults.startsOn, time, utc: false };
  }
  const parts = new Map<string, string>();
  for (const part of ruleText.split(";")) {
    if (!part.trim()) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) invalidRule(`Malformed rule part "${part.slice(0, 40)}".`);
    const key = part.slice(0, eq).trim().toUpperCase();
    if (parts.has(key)) invalidRule(`${key} appears more than once.`);
    parts.set(
      key,
      part
        .slice(eq + 1)
        .trim()
        .toUpperCase(),
    );
  }
  for (const key of parts.keys())
    if (!["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL", "WKST"].includes(key))
      invalidRule(`${key} is not supported.`);
  const freq = parts.get("FREQ");
  if (!freq || !(RECURRENCE_FREQUENCIES as readonly string[]).includes(freq))
    invalidRule("FREQ must be DAILY, WEEKLY or MONTHLY.");
  if (parts.has("WKST") && parts.get("WKST") !== "MO")
    invalidRule("Only WKST=MO is supported.");
  const interval = parts.has("INTERVAL") ? Number(parts.get("INTERVAL")) : 1;
  if (
    !Number.isInteger(interval) ||
    interval < 1 ||
    interval > RECURRENCE_LIMITS.interval
  )
    invalidRule(`INTERVAL must be 1..${RECURRENCE_LIMITS.interval}.`);
  const byDay: RecurrenceRule["byDay"] = [];
  if (parts.has("BYDAY")) {
    for (const token of (parts.get("BYDAY") as string).split(",")) {
      const match = /^([+-]?[1-5])?(MO|TU|WE|TH|FR|SA|SU)$/.exec(token.trim());
      if (!match) invalidRule(`Invalid BYDAY value "${token.slice(0, 10)}".`);
      const ordinal = match[1] ? Number(match[1]) : null;
      if (ordinal !== null && freq !== "MONTHLY")
        invalidRule("BYDAY ordinals such as 1MO are only valid with MONTHLY.");
      const weekday = match[2] as Weekday;
      if (
        byDay.some(
          (entry) => entry.weekday === weekday && entry.ordinal === ordinal,
        )
      )
        invalidRule("BYDAY repeats a value.");
      byDay.push({ weekday, ordinal });
    }
    if (!byDay.length) invalidRule("BYDAY is empty.");
  }
  if (parts.has("COUNT") && parts.has("UNTIL"))
    invalidRule("COUNT and UNTIL cannot be combined.");
  const count = parts.has("COUNT") ? Number(parts.get("COUNT")) : null;
  if (
    count !== null &&
    (!Number.isInteger(count) || count < 1 || count > RECURRENCE_LIMITS.count)
  )
    invalidRule(`COUNT must be 1..${RECURRENCE_LIMITS.count}.`);
  const until = parts.has("UNTIL")
    ? parseMoment(parts.get("UNTIL") as string, "UNTIL")
    : null;
  if (until && until.date < start.date)
    invalidRule("UNTIL is before the start date.");
  return {
    freq: freq as RecurrenceFrequency,
    interval,
    byDay,
    count,
    until,
    start,
  };
}

/** Canonical stored form: a DTSTART line and an RRULE line. */
export function formatRecurrenceRule(rule: RecurrenceRule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay.length)
    parts.push(
      `BYDAY=${rule.byDay
        .map((entry) => `${entry.ordinal ?? ""}${entry.weekday}`)
        .join(",")}`,
    );
  if (rule.count !== null) parts.push(`COUNT=${rule.count}`);
  if (rule.until) parts.push(`UNTIL=${formatMoment(rule.until)}`);
  return `DTSTART:${formatMoment(rule.start)}\nRRULE:${parts.join(";")}`;
}

function monthDates(rule: RecurrenceRule, year: number, month: number) {
  const first = Math.round(Date.UTC(year, month, 1) / 86_400_000);
  const length = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  if (!rule.byDay.length) {
    const day = Number(rule.start.date.slice(8, 10));
    return day <= length ? [first + day - 1] : [];
  }
  const days = new Set<number>();
  for (const { weekday, ordinal } of rule.byDay) {
    const target = WEEKDAYS.indexOf(weekday);
    const matches: number[] = [];
    for (let offset = 0; offset < length; offset++)
      if (weekdayIndex(first + offset) === target) matches.push(first + offset);
    if (ordinal === null) for (const day of matches) days.add(day);
    else {
      const pick = ordinal > 0 ? matches[ordinal - 1] : matches.at(ordinal);
      if (pick !== undefined) days.add(pick);
    }
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * Visits occurrences in chronological order from the rule's start until the
 * visitor returns false, COUNT or UNTIL ends the series, or the scan limit.
 */
function visitOccurrences(
  rule: RecurrenceRule,
  visit: (day: number) => boolean,
) {
  const startDay = dayNumber(rule.start.date);
  const lastDay = startDay + RECURRENCE_LIMITS.scanDays;
  const untilDay = rule.until ? dayNumber(rule.until.date) : null;
  const untilExcludesLastDay =
    rule.until?.time !== null &&
    rule.until?.time !== undefined &&
    rule.start.time !== null &&
    rule.start.time > rule.until.time;
  let emitted = 0;
  // Returns false to stop the scan.
  const emit = (day: number): boolean => {
    if (day < startDay) return true;
    if (day > lastDay) return false;
    if (untilDay !== null) {
      if (day > untilDay) return false;
      if (day === untilDay && untilExcludesLastDay) return false;
    }
    if (rule.count !== null && emitted >= rule.count) return false;
    emitted++;
    return visit(day);
  };
  const allowed = new Set(
    rule.byDay.map((entry) => WEEKDAYS.indexOf(entry.weekday)),
  );
  if (rule.freq === "DAILY") {
    const step = allowed.size ? 1 : rule.interval;
    for (let day = startDay; day <= lastDay; day += step) {
      if ((day - startDay) % rule.interval !== 0) continue;
      if (allowed.size && !allowed.has(weekdayIndex(day))) continue;
      if (!emit(day)) return;
    }
    return;
  }
  if (rule.freq === "WEEKLY") {
    const weekStart = startDay - weekdayIndex(startDay);
    const offsets = allowed.size
      ? [...allowed].sort((a, b) => a - b)
      : [weekdayIndex(startDay)];
    for (let week = weekStart; week <= lastDay; week += 7 * rule.interval) {
      for (const offset of offsets) if (!emit(week + offset)) return;
    }
    return;
  }
  const [startYear, startMonth] = rule.start.date.split("-").map(Number);
  for (let index = 0; index <= RECURRENCE_LIMITS.scanDays / 28; index++) {
    if (index % rule.interval !== 0) continue;
    const absolute = startMonth - 1 + index;
    const year = startYear + Math.floor(absolute / 12);
    const month = absolute % 12;
    if (Math.round(Date.UTC(year, month, 1) / 86_400_000) > lastDay) return;
    for (const day of monthDates(rule, year, month)) if (!emit(day)) return;
  }
}

/** Occurrence dates within [from, to], inclusive, chronological. */
export function occurrencesBetween(
  rule: RecurrenceRule,
  from: string,
  to: string,
  limit: number = RECURRENCE_LIMITS.occurrences,
): string[] {
  const first = dayNumber(from);
  const last = dayNumber(to);
  const found: string[] = [];
  if (last < first || limit < 1) return found;
  visitOccurrences(rule, (day) => {
    if (day > last) return false;
    if (day >= first) found.push(dateFromDay(day));
    return found.length < limit;
  });
  return found;
}

/** The first occurrence on or after `date`. */
export function nextOccurrence(
  rule: RecurrenceRule,
  date: string,
): string | null {
  const first = dayNumber(date);
  let next: string | null = null;
  visitOccurrences(rule, (day) => {
    if (day < first) return true;
    next = dateFromDay(day);
    return false;
  });
  return next;
}

/** The last occurrence strictly before `date`. */
export function previousOccurrence(
  rule: RecurrenceRule,
  date: string,
): string | null {
  const before = dayNumber(date);
  let previous: string | null = null;
  visitOccurrences(rule, (day) => {
    if (day >= before) return false;
    previous = dateFromDay(day);
    return true;
  });
  return previous;
}

const WEEKDAY_NAMES: Record<Weekday, string> = {
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
};
const ORDINALS: Record<string, string> = {
  "1": "first",
  "2": "second",
  "3": "third",
  "4": "fourth",
  "5": "fifth",
  "-1": "last",
  "-2": "second to last",
  "-3": "third to last",
  "-4": "fourth to last",
  "-5": "fifth to last",
};
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function list(values: string[]): string {
  if (values.length < 2) return values.join("");
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

/** "Tue 27 Oct 2026" */
export function formatTaskDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${WEEKDAY_NAMES[weekdayOf(date)].slice(0, 3)} ${d} ${MONTHS[m - 1]} ${y}`;
}

/** English description for the app, e.g. "Every 2 weeks on Tuesday at 09:00". */
export function describeRecurrence(rule: RecurrenceRule): string {
  const unit = { DAILY: "day", WEEKLY: "week", MONTHLY: "month" }[rule.freq];
  let text =
    rule.interval === 1 ? `Every ${unit}` : `Every ${rule.interval} ${unit}s`;
  if (rule.freq === "MONTHLY") {
    text += rule.byDay.length
      ? ` on the ${list(
          rule.byDay.map(
            (entry) =>
              `${entry.ordinal === null ? "every" : ORDINALS[String(entry.ordinal)]} ${WEEKDAY_NAMES[entry.weekday]}`,
          ),
        )}`
      : ` on day ${Number(rule.start.date.slice(8, 10))}`;
  } else if (rule.byDay.length)
    text += ` on ${list(rule.byDay.map((entry) => WEEKDAY_NAMES[entry.weekday]))}`;
  else if (rule.freq === "WEEKLY")
    text += ` on ${WEEKDAY_NAMES[weekdayOf(rule.start.date)]}`;
  if (rule.start.time)
    text += ` at ${rule.start.time}${rule.start.utc ? " UTC" : ""}`;
  if (rule.count !== null)
    text += `, ${rule.count} time${rule.count === 1 ? "" : "s"}`;
  if (rule.until) text += `, until ${formatTaskDate(rule.until.date)}`;
  return text;
}

/** Today's calendar date in the owner's task time zone. */
export function todayInTaskZone(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TASK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

// ---------------------------------------------------------------------------
// Owner service

const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24 hours)");

const templateFields = {
  title: taskLine(TASK_LIMITS.title),
  description: z
    .string()
    .overwrite(sanitizeTaskText)
    .max(TASK_LIMITS.description)
    .optional(),
  acceptanceCriteria: z
    .array(taskLine(TASK_LIMITS.acceptanceCriterion))
    .max(TASK_LIMITS.acceptanceCriteria)
    .optional(),
  priority: z.number().int().min(0).max(3).optional(),
  expectedOutput: z.enum(TASK_EXPECTED_OUTPUTS).optional(),
  /** Days before the occurrence at which the instance is created. */
  leadDays: z.number().int().min(0).max(60).optional(),
  /** Whether instances are due on their occurrence date (default true). */
  dueOnOccurrence: z.boolean().optional(),
};

/** Stored in brain_task_recurrences.template. */
export const recurrenceTemplateSchema = z.object(templateFields).strict();
export type RecurrenceTemplate = z.output<typeof recurrenceTemplateSchema>;

export const createRecurrenceSchema = z
  .object({
    kind: z.enum(TASK_RECURRENCE_KINDS).default("task"),
    ...templateFields,
    projectRef: pageRefSchema.optional(),
    rrule: z
      .string()
      .trim()
      .min(1)
      .max(TASK_LIMITS.rrule)
      .describe('e.g. "FREQ=WEEKLY;BYDAY=TU" or a DTSTART line plus RRULE'),
    startsOn: z.iso.date().optional(),
    time: hhmm.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.kind === "meeting" && !input.projectRef)
      context.addIssue({
        code: "custom",
        path: ["projectRef"],
        message: "A meeting series belongs to a project",
      });
  });

export const updateRecurrenceSchema = z
  .object({
    title: templateFields.title.optional(),
    description: templateFields.description,
    acceptanceCriteria: templateFields.acceptanceCriteria,
    priority: templateFields.priority,
    expectedOutput: templateFields.expectedOutput,
    leadDays: templateFields.leadDays,
    dueOnOccurrence: templateFields.dueOnOccurrence,
    projectRef: pageRefSchema.nullable().optional(),
    rrule: z.string().trim().min(1).max(TASK_LIMITS.rrule).optional(),
    startsOn: z.iso.date().optional(),
    time: hhmm.nullable().optional(),
  })
  .strict()
  .refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    {
      message: "Change at least one field",
    },
  );

export interface RecurrenceView {
  id: string;
  kind: TaskRecurrenceKind;
  title: string;
  template: RecurrenceTemplate;
  rrule: string;
  rule: RecurrenceRule;
  description: string;
  project: { id: string; slug: string; title: string; type: string } | null;
  /** The next occurrence the task keeper will instantiate (task) or the next meeting date. */
  nextOn: string | null;
  paused: boolean;
  pausedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function recurrenceNotFound(id: string): BrainError {
  return taskError(
    "RECURRENCE_NOT_FOUND",
    "That recurrence does not exist.",
    "Reload the list of recurrences and pick an existing one.",
    { id },
  );
}

const RECURRENCE_SELECT = `SELECT r.id, r.kind, r.template, r.rrule, r.paused_at, r.created_at, r.updated_at,
  to_char(r.next_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS next_on,
  p.id AS project_id, p.slug AS project_slug, p.title AS project_title, p.type AS project_type
FROM brain_task_recurrences r
LEFT JOIN brain_pages p ON p.owner_id = r.owner_id AND p.id = r.project_page_id`;

function recurrenceView(row: Record<string, unknown>): RecurrenceView {
  const template = row.template as RecurrenceTemplate;
  const rule = parseRecurrenceRule(row.rrule as string);
  return {
    id: row.id as string,
    kind: row.kind as TaskRecurrenceKind,
    title: template.title,
    template,
    rrule: row.rrule as string,
    rule,
    description: describeRecurrence(rule),
    project: row.project_id
      ? {
          id: row.project_id as string,
          slug: row.project_slug as string,
          title: row.project_title as string,
          type: row.project_type as string,
        }
      : null,
    nextOn: (row.next_on as string | null) ?? null,
    paused: row.paused_at !== null,
    pausedAt: iso(row.paused_at as string | null),
    createdAt: iso(row.created_at as string) as string,
    updatedAt: iso(row.updated_at as string) as string,
  };
}

/** next_at holds the next occurrence date at 00:00 UTC (a date watermark). */
export function nextAtValue(date: string | null): string | null {
  return date ? `${date}T00:00:00Z` : null;
}

async function loadRecurrence(
  db: Database,
  ownerId: string,
  id: string,
  lock = false,
): Promise<RecurrenceView> {
  if (!z.uuid().safeParse(id).success) throw recurrenceNotFound(id);
  if (lock)
    await db.query(
      "SELECT 1 FROM brain_task_recurrences WHERE owner_id = $1 AND id = $2 FOR UPDATE",
      [ownerId, id],
    );
  const { rows } = await db.query(
    `${RECURRENCE_SELECT} WHERE r.owner_id = $1 AND r.id = $2`,
    [ownerId, id],
  );
  if (!rows[0]) throw recurrenceNotFound(id);
  return recurrenceView(rows[0]);
}

export async function listRecurrences(
  ownerId: string,
  options: { kind?: TaskRecurrenceKind } = {},
): Promise<RecurrenceView[]> {
  assertOwner(ownerId);
  const { rows } = await getPool().query(
    `${RECURRENCE_SELECT} WHERE r.owner_id = $1 AND ($2::text IS NULL OR r.kind = $2)
     ORDER BY r.paused_at IS NOT NULL, r.next_at NULLS LAST, r.created_at, r.id`,
    [ownerId, options.kind ?? null],
  );
  return rows.map(recurrenceView);
}

export async function getRecurrence(
  ownerId: string,
  id: string,
): Promise<RecurrenceView> {
  assertOwner(ownerId);
  return loadRecurrence(getPool(), ownerId, id);
}

function templateOf(
  input: Partial<Record<keyof typeof templateFields, unknown>>,
): RecurrenceTemplate {
  const template: Record<string, unknown> = {};
  for (const key of Object.keys(templateFields))
    if (input[key as keyof typeof templateFields] !== undefined)
      template[key] = input[key as keyof typeof templateFields];
  return recurrenceTemplateSchema.parse(template);
}

/** The owner creates a series; the first occurrence from today is its watermark. */
export async function createRecurrence(
  actor: Actor,
  input: unknown,
  today: string = todayInTaskZone(),
): Promise<RecurrenceView> {
  assertOwnerActor(actor);
  const data = parseTaskInput(createRecurrenceSchema, input);
  const rule = parseRecurrenceRule(data.rrule, {
    startsOn: data.startsOn ?? today,
    time: data.time ?? null,
  });
  const template = templateOf(data);
  const next = nextOccurrence(rule, today);
  return transaction(async (db) => {
    const project = data.projectRef
      ? await resolveProject(db, actor.ownerId, data.projectRef)
      : null;
    const { rows } = await db.query(
      `INSERT INTO brain_task_recurrences (owner_id, kind, template, rrule, next_at, project_page_id, created_by_agent_id)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7) RETURNING id`,
      [
        actor.ownerId,
        data.kind,
        JSON.stringify(template),
        formatRecurrenceRule(rule),
        nextAtValue(next),
        project?.id ?? null,
        actor.agentId,
      ],
    );
    return loadRecurrence(db, actor.ownerId, rows[0].id);
  });
}

/** Edits the template, rule or project; a changed rule restarts from today. */
export async function updateRecurrence(
  actor: Actor,
  id: string,
  input: unknown,
  today: string = todayInTaskZone(),
): Promise<RecurrenceView> {
  assertOwnerActor(actor);
  const patch = parseTaskInput(updateRecurrenceSchema, input);
  return transaction(async (db) => {
    const current = await loadRecurrence(db, actor.ownerId, id, true);
    const template = templateOf({ ...current.template, ...patch });
    const ruleChanged =
      patch.rrule !== undefined ||
      patch.startsOn !== undefined ||
      patch.time !== undefined;
    let rule = current.rule;
    if (ruleChanged) {
      const base = patch.rrule ?? current.rrule;
      const hasStart = /(^|\n)\s*DTSTART/i.test(base);
      rule = parseRecurrenceRule(
        hasStart && (patch.startsOn !== undefined || patch.time !== undefined)
          ? (base.split(/\r?\n/).find((line) => !/^\s*DTSTART/i.test(line)) ??
              base)
          : base,
        {
          startsOn: patch.startsOn ?? current.rule.start.date,
          time: patch.time === undefined ? current.rule.start.time : patch.time,
        },
      );
    }
    if (current.kind === "meeting" && patch.projectRef === null)
      throw new BrainError(
        "INVALID_INPUT",
        "A meeting series belongs to a project.",
        400,
        { remedy: "Choose another project instead of removing it." },
      );
    const project =
      patch.projectRef === undefined
        ? current.project
        : patch.projectRef === null
          ? null
          : await resolveProject(db, actor.ownerId, patch.projectRef);
    const next = ruleChanged ? nextOccurrence(rule, today) : current.nextOn;
    await db.query(
      `UPDATE brain_task_recurrences SET template = $3::jsonb, rrule = $4, next_at = $5,
         project_page_id = $6, updated_at = now()
       WHERE owner_id = $1 AND id = $2`,
      [
        actor.ownerId,
        id,
        JSON.stringify(template),
        formatRecurrenceRule(rule),
        nextAtValue(next),
        project?.id ?? null,
      ],
    );
    return loadRecurrence(db, actor.ownerId, id);
  });
}

/**
 * Pausing stops instances; resuming skips the occurrences missed while paused
 * by moving the watermark to the next occurrence from today.
 */
export async function setRecurrencePaused(
  actor: Actor,
  id: string,
  paused: boolean,
  today: string = todayInTaskZone(),
): Promise<RecurrenceView> {
  assertOwnerActor(actor);
  return transaction(async (db) => {
    const current = await loadRecurrence(db, actor.ownerId, id, true);
    if (current.paused === paused) return current;
    const next = paused ? current.nextOn : nextOccurrence(current.rule, today);
    await db.query(
      `UPDATE brain_task_recurrences SET paused_at = CASE WHEN $3 THEN now() END, next_at = $4, updated_at = now()
       WHERE owner_id = $1 AND id = $2`,
      [actor.ownerId, id, paused, nextAtValue(next)],
    );
    return loadRecurrence(db, actor.ownerId, id);
  });
}

/** Deleting a series keeps its instances (recurrence_id becomes NULL). */
export async function deleteRecurrence(actor: Actor, id: string) {
  assertOwnerActor(actor);
  if (!z.uuid().safeParse(id).success) throw recurrenceNotFound(id);
  const { rowCount } = await getPool().query(
    "DELETE FROM brain_task_recurrences WHERE owner_id = $1 AND id = $2",
    [actor.ownerId, id],
  );
  if (!rowCount) throw recurrenceNotFound(id);
  return { deleted: true };
}
