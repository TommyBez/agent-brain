import assert from "node:assert/strict";
import test from "node:test";
import { BrainError } from "../lib/brain/types";
import { pendingOccurrences } from "../lib/maintenance/task-keeper/recurrences";
import {
  type Agenda,
  type AgendaTask,
  agendaMarkdown,
  classifyAgendaTasks,
} from "../lib/tasks/agenda";
import { meetingDates } from "../lib/tasks/meetings";
import {
  addDays,
  describeRecurrence,
  formatRecurrenceRule,
  formatTaskDate,
  nextOccurrence,
  occurrencesBetween,
  parseRecurrenceRule,
  previousOccurrence,
  todayInTaskZone,
  weekdayOf,
} from "../lib/tasks/recurrences";

const invalid = (text: string, defaults?: { startsOn?: string }) =>
  assert.throws(
    () => parseRecurrenceRule(text, defaults),
    (error: unknown) =>
      error instanceof BrainError && error.code === "INVALID_RRULE",
    text,
  );

test("RRULE subset: parse, canonical form and validation", () => {
  const rule = parseRecurrenceRule("RRULE:FREQ=WEEKLY;BYDAY=TU,FR;INTERVAL=2", {
    startsOn: "2026-10-20",
    time: "09:30",
  });
  assert.deepEqual(rule, {
    freq: "WEEKLY",
    interval: 2,
    byDay: [
      { weekday: "TU", ordinal: null },
      { weekday: "FR", ordinal: null },
    ],
    count: null,
    until: null,
    start: { date: "2026-10-20", time: "09:30", utc: false },
  });
  const text = formatRecurrenceRule(rule);
  assert.equal(
    text,
    "DTSTART:20261020T093000\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,FR",
  );
  assert.deepEqual(parseRecurrenceRule(text), rule, "round trip");
  assert.deepEqual(
    parseRecurrenceRule("DTSTART;VALUE=DATE:20261101\nFREQ=MONTHLY;BYDAY=-1FR")
      .byDay,
    [{ weekday: "FR", ordinal: -1 }],
  );
  invalid("FREQ=YEARLY", { startsOn: "2026-10-20" });
  invalid("FREQ=WEEKLY;BYMONTH=3", { startsOn: "2026-10-20" });
  invalid("FREQ=WEEKLY;BYDAY=1MO", { startsOn: "2026-10-20" });
  invalid("FREQ=DAILY;COUNT=3;UNTIL=20261101", { startsOn: "2026-10-20" });
  invalid("FREQ=DAILY;INTERVAL=0", { startsOn: "2026-10-20" });
  invalid("FREQ=DAILY");
  invalid("DTSTART:20260230\nRRULE:FREQ=DAILY");
  invalid("FREQ=DAILY;UNTIL=20261001", { startsOn: "2026-10-20" });
});

test("weekly, daily and monthly occurrences, with COUNT and UNTIL", () => {
  const weekly = parseRecurrenceRule("FREQ=WEEKLY", { startsOn: "2026-10-20" });
  assert.equal(weekdayOf("2026-10-20"), "TU");
  assert.deepEqual(occurrencesBetween(weekly, "2026-10-01", "2026-11-10"), [
    "2026-10-20",
    "2026-10-27",
    "2026-11-03",
    "2026-11-10",
  ]);
  const biweekly = parseRecurrenceRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH", {
    startsOn: "2026-10-21",
  });
  // The start week (from Wednesday) keeps only Thursday; the next week is skipped.
  assert.deepEqual(occurrencesBetween(biweekly, "2026-10-19", "2026-11-08"), [
    "2026-10-22",
    "2026-11-02",
    "2026-11-05",
  ]);
  const workdays = parseRecurrenceRule(
    "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=4",
    { startsOn: "2026-10-23" },
  );
  assert.deepEqual(occurrencesBetween(workdays, "2026-10-01", "2026-12-31"), [
    "2026-10-23",
    "2026-10-26",
    "2026-10-27",
    "2026-10-28",
  ]);
  const everyThirdDay = parseRecurrenceRule("FREQ=DAILY;INTERVAL=3", {
    startsOn: "2026-10-30",
  });
  assert.deepEqual(
    occurrencesBetween(everyThirdDay, "2026-10-30", "2026-11-06"),
    ["2026-10-30", "2026-11-02", "2026-11-05"],
  );
  const monthEnd = parseRecurrenceRule("FREQ=MONTHLY;UNTIL=20270430", {
    startsOn: "2026-12-31",
  });
  // Months without a 31st are skipped, as RFC 5545 specifies.
  assert.deepEqual(occurrencesBetween(monthEnd, "2026-01-01", "2027-12-31"), [
    "2026-12-31",
    "2027-01-31",
    "2027-03-31",
  ]);
  const firstMonday = parseRecurrenceRule("FREQ=MONTHLY;BYDAY=1MO", {
    startsOn: "2026-10-01",
  });
  assert.deepEqual(
    occurrencesBetween(firstMonday, "2026-10-01", "2027-01-31"),
    ["2026-10-05", "2026-11-02", "2026-12-07", "2027-01-04"],
  );
  const lastFriday = parseRecurrenceRule("FREQ=MONTHLY;BYDAY=-1FR;COUNT=2", {
    startsOn: "2026-10-01",
  });
  assert.deepEqual(occurrencesBetween(lastFriday, "2026-01-01", "2027-12-31"), [
    "2026-10-30",
    "2026-11-27",
  ]);
  assert.equal(nextOccurrence(lastFriday, "2026-11-28"), null, "COUNT ended");
  assert.equal(nextOccurrence(weekly, "2026-10-21"), "2026-10-27");
  assert.equal(nextOccurrence(weekly, "2026-10-27"), "2026-10-27", "inclusive");
  assert.equal(previousOccurrence(weekly, "2026-10-27"), "2026-10-20");
  assert.equal(previousOccurrence(weekly, "2026-10-20"), null);
  const untilTime = parseRecurrenceRule(
    "DTSTART:20261020T100000\nRRULE:FREQ=DAILY;UNTIL=20261022T090000",
  );
  assert.deepEqual(occurrencesBetween(untilTime, "2026-10-01", "2026-10-31"), [
    "2026-10-20",
    "2026-10-21",
  ]);
});

test("descriptions and dates for the app", () => {
  assert.equal(
    describeRecurrence(
      parseRecurrenceRule("FREQ=WEEKLY;BYDAY=TU", {
        startsOn: "2026-10-20",
        time: "09:00",
      }),
    ),
    "Every week on Tuesday at 09:00",
  );
  assert.equal(
    describeRecurrence(
      parseRecurrenceRule("FREQ=MONTHLY;BYDAY=1MO,-1FR;COUNT=6", {
        startsOn: "2026-10-01",
      }),
    ),
    "Every month on the first Monday and last Friday, 6 times",
  );
  assert.equal(
    describeRecurrence(
      parseRecurrenceRule("FREQ=DAILY;INTERVAL=2;UNTIL=20261130", {
        startsOn: "2026-10-01",
      }),
    ),
    "Every 2 days, until Mon 30 Nov 2026",
  );
  assert.equal(formatTaskDate("2026-10-27"), "Tue 27 Oct 2026");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(todayInTaskZone(new Date("2026-10-20T23:30:00Z")), "2026-10-21");
});

test("recurrence instances: one per occurrence from the watermark, latest seven", () => {
  const daily = parseRecurrenceRule("FREQ=DAILY", { startsOn: "2026-10-01" });
  assert.deepEqual(pendingOccurrences(daily, "2026-10-21", "2026-10-21", 0), {
    dates: ["2026-10-21"],
    skipped: 0,
    next: "2026-10-22",
  });
  // Already instantiated today: the watermark is tomorrow, nothing is due.
  assert.deepEqual(pendingOccurrences(daily, "2026-10-22", "2026-10-21", 0), {
    dates: [],
    skipped: 0,
    next: "2026-10-22",
  });
  const missed = pendingOccurrences(daily, "2026-10-01", "2026-10-21", 0);
  assert.equal(missed.dates.length, 7);
  assert.equal(missed.dates[0], "2026-10-15");
  assert.equal(missed.skipped, 14);
  assert.equal(missed.next, "2026-10-22");
  const weekly = parseRecurrenceRule("FREQ=WEEKLY;BYDAY=MO", {
    startsOn: "2026-10-01",
  });
  // Two days of lead time create Monday's instance on Saturday.
  assert.deepEqual(pendingOccurrences(weekly, "2026-10-26", "2026-10-24", 2), {
    dates: ["2026-10-26"],
    skipped: 0,
    next: "2026-11-02",
  });
  assert.deepEqual(pendingOccurrences(weekly, null, "2026-10-21", 0), {
    dates: [],
    skipped: 0,
    next: "2026-10-26",
  });
  const finished = parseRecurrenceRule("FREQ=DAILY;COUNT=1", {
    startsOn: "2026-10-01",
  });
  assert.deepEqual(pendingOccurrences(finished, null, "2026-10-21", 0), {
    dates: [],
    skipped: 0,
    next: null,
  });
});

function agendaTask(
  overrides: Partial<AgendaTask> & { ref: string },
): AgendaTask {
  return {
    id: overrides.ref,
    title: {
      value: `Task ${overrides.ref}`,
      untrusted: true,
      authoredBy: "Task keeper",
    },
    status: "ready",
    priority: 2,
    due: { kind: "unset", on: null, at: null, text: null, date: null },
    leads: [],
    closedAt: null,
    ...overrides,
  };
}

test("agenda: due at the next meeting (events included), overdue, closed since last", () => {
  const meeting = parseRecurrenceRule("FREQ=WEEKLY;BYDAY=TU", {
    startsOn: "2026-10-06",
    time: "09:00",
  });
  assert.deepEqual(meetingDates(meeting, "2026-10-21"), {
    next: "2026-10-27",
    previous: "2026-10-20",
  });
  assert.deepEqual(meetingDates(meeting, "2026-10-27"), {
    next: "2026-10-27",
    previous: "2026-10-20",
  });
  const date = (on: string) => ({
    kind: "date" as const,
    on,
    at: null,
    text: null,
    date: on,
  });
  const tasks = [
    agendaTask({ ref: "T-1", due: date("2026-10-27") }),
    agendaTask({
      ref: "T-2",
      priority: 0,
      due: {
        kind: "event",
        on: null,
        at: null,
        text: "alla prossima riunione",
        date: null,
      },
      leads: ["Mario Rossi"],
    }),
    agendaTask({ ref: "T-3", due: date("2026-10-19"), status: "in_progress" }),
    agendaTask({ ref: "T-4", due: date("2026-11-10") }),
    agendaTask({
      ref: "T-5",
      status: "done",
      closedAt: "2026-10-21T08:00:00.000Z",
    }),
    agendaTask({
      ref: "T-6",
      status: "canceled",
      closedAt: "2026-10-19T08:00:00.000Z",
    }),
    agendaTask({ ref: "T-7", due: date("2026-10-21") }),
  ];
  const sections = classifyAgendaTasks(tasks, {
    today: "2026-10-21",
    meeting: "2026-10-27",
    since: "2026-10-19T22:00:00.000Z",
  });
  assert.deepEqual(
    sections.dueAtMeeting.map((task) => task.ref),
    ["T-7", "T-1", "T-2"],
  );
  assert.deepEqual(
    sections.overdue.map((task) => task.ref),
    ["T-3"],
  );
  assert.deepEqual(
    sections.closedSinceLast.map((task) => task.ref),
    ["T-5"],
  );
  const agenda: Agenda = {
    series: {
      id: "s",
      title: "Riunione settimanale JSB",
      project: { id: "p", slug: "project/jsb", title: "JSB", type: "project" },
      description: "Every week on Tuesday at 09:00",
      time: "09:00",
      paused: false,
    },
    today: "2026-10-21",
    meeting: "2026-10-27",
    previousMeeting: "2026-10-20",
    ...sections,
  };
  assert.equal(
    agendaMarkdown(agenda),
    [
      "# Riunione settimanale JSB · Tue 27 Oct 2026, 09:00",
      "",
      "Project: JSB",
      "",
      "## Due at this meeting (3)",
      "",
      "- T-7 Task T-7 — due Wed 21 Oct 2026 · ready",
      "- T-1 Task T-1 — due Tue 27 Oct 2026 · ready",
      '- T-2 Task T-2 — "alla prossima riunione" · lead Mario Rossi · ready',
      "",
      "## Overdue (1)",
      "",
      "- T-3 Task T-3 — due Mon 19 Oct 2026 · in progress",
      "",
      "## Closed since the last meeting (Tue 20 Oct 2026) (1)",
      "",
      "- T-5 Task T-5 — done",
      "",
    ].join("\n"),
  );
  assert.match(
    agendaMarkdown({
      ...agenda,
      meeting: null,
      dueAtMeeting: [],
      overdue: [],
      closedSinceLast: [],
    }),
    /no upcoming meeting[\s\S]*None\./,
  );
});
