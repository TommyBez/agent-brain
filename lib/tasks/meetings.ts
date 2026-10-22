import { assertOwner } from "../brain/utils";
import type { Actor } from "./actors";
import {
  createRecurrence,
  getRecurrence,
  listRecurrences,
  nextOccurrence,
  previousOccurrence,
  type RecurrenceRule,
  type RecurrenceView,
  todayInTaskZone,
} from "./recurrences";

// Meeting series: a `meeting` recurrence carries the meeting's RRULE and its
// project; the agenda derives the next and previous meeting dates from it.

export interface MeetingDates {
  /** The next meeting on or after today, or null when the series ended. */
  next: string | null;
  /** The meeting before `next` (or before today when the series ended). */
  previous: string | null;
}

export interface MeetingSeriesView extends RecurrenceView {
  time: string | null;
  nextMeeting: string | null;
  previousMeeting: string | null;
}

export function meetingDates(
  rule: RecurrenceRule,
  today: string,
): MeetingDates {
  const next = nextOccurrence(rule, today);
  return { next, previous: previousOccurrence(rule, next ?? today) };
}

function meetingView(series: RecurrenceView, today: string): MeetingSeriesView {
  const dates = series.paused
    ? { next: null, previous: previousOccurrence(series.rule, today) }
    : meetingDates(series.rule, today);
  return {
    ...series,
    time: series.rule.start.time,
    nextMeeting: dates.next,
    previousMeeting: dates.previous,
  };
}

export async function listMeetingSeries(
  ownerId: string,
  today: string = todayInTaskZone(),
): Promise<MeetingSeriesView[]> {
  assertOwner(ownerId);
  const series = await listRecurrences(ownerId, { kind: "meeting" });
  return series
    .map((item) => meetingView(item, today))
    .sort(
      (a, b) =>
        Number(a.paused) - Number(b.paused) ||
        (a.nextMeeting ?? "9999").localeCompare(b.nextMeeting ?? "9999") ||
        a.title.localeCompare(b.title),
    );
}

export async function getMeetingSeries(
  ownerId: string,
  id: string,
  today: string = todayInTaskZone(),
): Promise<MeetingSeriesView | null> {
  const series = await getRecurrence(ownerId, id);
  return series.kind === "meeting" ? meetingView(series, today) : null;
}

/** The owner creates a meeting series: title, project and the meeting RRULE. */
export async function createMeetingSeries(
  actor: Actor,
  input: Record<string, unknown>,
  today: string = todayInTaskZone(),
): Promise<MeetingSeriesView> {
  const series = await createRecurrence(
    actor,
    { ...input, kind: "meeting" },
    today,
  );
  return meetingView(series, today);
}
