import { BrainError } from "../brain/types";
import { assertOwner } from "../brain/utils";
import { getPool } from "../db";
import { getMeetingSeries, type MeetingSeriesView } from "./meetings";
import { type Authored, authored, iso } from "./records";
import { formatTaskDate, TASK_TIME_ZONE, todayInTaskZone } from "./recurrences";
import {
  formatTaskRef,
  type TaskDueKind,
  type TaskStatus,
  TERMINAL_TASK_STATUSES,
} from "./types";

// Agenda of a meeting series (§9, §12 block D): open tasks of the series'
// project due at the next meeting (including due_kind `event`, e.g. "next
// meeting"), overdue ones, and tasks closed since the previous meeting.

export interface AgendaTask {
  id: string;
  ref: string;
  title: Authored<string>;
  status: TaskStatus;
  priority: number;
  due: {
    kind: TaskDueKind;
    on: string | null;
    at: string | null;
    text: string | null;
    /** Effective calendar date in the task time zone. */
    date: string | null;
  };
  leads: string[];
  closedAt: string | null;
}

export interface Agenda {
  series: Pick<
    MeetingSeriesView,
    "id" | "title" | "project" | "description" | "time" | "paused"
  >;
  today: string;
  meeting: string | null;
  previousMeeting: string | null;
  dueAtMeeting: AgendaTask[];
  overdue: AgendaTask[];
  closedSinceLast: AgendaTask[];
}

const TERMINAL = TERMINAL_TASK_STATUSES as readonly string[];

/** Pure classification, exported for tests. */
export function classifyAgendaTasks(
  tasks: AgendaTask[],
  dates: { today: string; meeting: string | null; since: string | null },
): Pick<Agenda, "dueAtMeeting" | "overdue" | "closedSinceLast"> {
  const dueAtMeeting: AgendaTask[] = [];
  const overdue: AgendaTask[] = [];
  const closedSinceLast: AgendaTask[] = [];
  for (const task of tasks) {
    if (TERMINAL.includes(task.status)) {
      if (task.closedAt && (!dates.since || task.closedAt >= dates.since))
        closedSinceLast.push(task);
      continue;
    }
    const date = task.due.date;
    if (date && date < dates.today) overdue.push(task);
    else if (
      task.due.kind === "event" ||
      (date && dates.meeting && date <= dates.meeting)
    )
      dueAtMeeting.push(task);
  }
  const byDue = (a: AgendaTask, b: AgendaTask) =>
    (a.due.date ?? "9999-12-31").localeCompare(b.due.date ?? "9999-12-31") ||
    a.priority - b.priority ||
    a.ref.localeCompare(b.ref, undefined, { numeric: true });
  dueAtMeeting.sort(byDue);
  overdue.sort(byDue);
  closedSinceLast.sort(
    (a, b) =>
      (b.closedAt ?? "").localeCompare(a.closedAt ?? "") ||
      a.ref.localeCompare(b.ref, undefined, { numeric: true }),
  );
  return { dueAtMeeting, overdue, closedSinceLast };
}

/** Start of a calendar day in the task time zone, as an ISO instant. */
async function dayStart(date: string): Promise<string> {
  const { rows } = await getPool().query(
    "SELECT ($1::date::timestamp AT TIME ZONE $2) AS start",
    [date, TASK_TIME_ZONE],
  );
  return iso(rows[0].start) as string;
}

/** Agenda for a meeting series; null when the series does not exist. */
export async function getMeetingAgenda(
  ownerId: string,
  seriesId: string,
  today: string = todayInTaskZone(),
): Promise<Agenda | null> {
  assertOwner(ownerId);
  const series = await getMeetingSeries(ownerId, seriesId, today).catch(
    (error: unknown) => {
      if (error instanceof BrainError && error.code === "RECURRENCE_NOT_FOUND")
        return null;
      throw error;
    },
  );
  if (!series) return null;
  const meeting = series.nextMeeting;
  const previous = series.previousMeeting;
  const since = await dayStart(previous ?? series.rule.start.date);
  const tasks: AgendaTask[] = [];
  if (series.project) {
    const { rows } = await getPool().query(
      `SELECT t.id, t.number, t.title, t.status, t.priority, t.due_kind,
         to_char(t.due_on, 'YYYY-MM-DD') AS due_on, t.due_at, t.due_text,
         to_char(COALESCE(t.due_on, (t.due_at AT TIME ZONE $4)::date), 'YYYY-MM-DD') AS due_date,
         creator.label AS creator_label, creator.kind AS creator_kind, closed.closed_at,
         COALESCE((SELECT array_agg(COALESCE(a.label, pg.title, p.group_label) ORDER BY p.created_at, p.id)
           FROM brain_task_parties p
           LEFT JOIN brain_agents a ON a.owner_id = p.owner_id AND a.id = p.agent_id
           LEFT JOIN brain_pages pg ON pg.owner_id = p.owner_id AND pg.id = p.person_page_id
           WHERE p.owner_id = t.owner_id AND p.task_id = t.id AND p.role = 'lead'), '{}') AS leads
       FROM brain_tasks t
       JOIN brain_agents creator ON creator.owner_id = t.owner_id AND creator.id = t.created_by_agent_id
       LEFT JOIN LATERAL (
         SELECT max(e.created_at) AS closed_at FROM brain_task_events e
         WHERE e.owner_id = t.owner_id AND e.task_id = t.id AND e.to_status = ANY($5::text[])
       ) closed ON t.status = ANY($5::text[])
       WHERE t.owner_id = $1 AND t.project_page_id = $2 AND t.archived_at IS NULL
         AND (
           (t.status <> ALL($5::text[]) AND (t.due_kind = 'event' OR t.due_on IS NOT NULL OR t.due_at IS NOT NULL))
           OR (t.status = ANY($5::text[]) AND closed.closed_at >= $3::timestamptz)
         )
       ORDER BY t.number
       LIMIT 500`,
      [ownerId, series.project.id, since, TASK_TIME_ZONE, TERMINAL],
    );
    for (const row of rows)
      tasks.push({
        id: row.id,
        ref: formatTaskRef(row.number),
        title: authored(row.title as string, {
          label: row.creator_label,
          kind: row.creator_kind,
        }),
        status: row.status,
        priority: row.priority,
        due: {
          kind: row.due_kind,
          on: row.due_on,
          at: iso(row.due_at),
          text: row.due_text,
          date: row.due_date,
        },
        leads: (row.leads as (string | null)[]).filter((lead): lead is string =>
          Boolean(lead),
        ),
        closedAt: iso(row.closed_at),
      });
  }
  const sections = classifyAgendaTasks(tasks, { today, meeting, since });
  return {
    series: {
      id: series.id,
      title: series.title,
      project: series.project,
      description: series.description,
      time: series.time,
      paused: series.paused,
    },
    today,
    meeting,
    previousMeeting: previous,
    ...sections,
  };
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function dueLabel(task: AgendaTask): string {
  const parts: string[] = [];
  if (task.due.date) parts.push(`due ${formatTaskDate(task.due.date)}`);
  if (task.due.text) parts.push(`"${oneLine(task.due.text)}"`);
  return parts.join(" ");
}

function taskLine(task: AgendaTask, closed = false): string {
  const details = [
    closed ? task.status : dueLabel(task),
    task.leads.length ? `lead ${task.leads.map(oneLine).join(", ")}` : "",
    closed ? "" : task.status.replace("_", " "),
  ].filter(Boolean);
  return `- ${task.ref} ${oneLine(task.title.value)}${details.length ? ` — ${details.join(" · ")}` : ""}`;
}

function section(title: string, tasks: AgendaTask[], closed = false) {
  return [
    `## ${title} (${tasks.length})`,
    "",
    ...(tasks.length ? tasks.map((task) => taskLine(task, closed)) : ["None."]),
    "",
  ];
}

/** Markdown for "Copy as Markdown": English headings, the owner's content. */
export function agendaMarkdown(agenda: Agenda): string {
  const when = agenda.meeting
    ? `${formatTaskDate(agenda.meeting)}${agenda.series.time ? `, ${agenda.series.time}` : ""}`
    : "no upcoming meeting";
  const lines = [
    `# ${oneLine(agenda.series.title)} · ${when}`,
    "",
    ...(agenda.series.project
      ? [`Project: ${oneLine(agenda.series.project.title)}`, ""]
      : []),
    ...section("Due at this meeting", agenda.dueAtMeeting),
    ...section("Overdue", agenda.overdue),
    ...section(
      agenda.previousMeeting
        ? `Closed since the last meeting (${formatTaskDate(agenda.previousMeeting)})`
        : "Closed since the series started",
      agenda.closedSinceLast,
      true,
    ),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}
