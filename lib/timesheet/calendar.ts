import { z } from "zod";

const todayFormat = new Intl.DateTimeFormat("en-CA", {
  dateStyle: "short",
  timeZone: "Europe/Rome",
});
const monthFormat = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const dayFormat = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

export function timesheetToday() {
  return todayFormat.format(new Date());
}

export function isTimesheetDate(value: string | null): value is string {
  return z.iso.date().safeParse(value).success && value?.slice(0, 4) !== "0000";
}

export function timesheetDayLabel(day: string) {
  return dayFormat.format(new Date(day));
}

export function timesheetMonth(day: string) {
  const from = `${day.slice(0, 7)}-01`;
  const first = new Date(from);
  const next = new Date(first);
  next.setUTCMonth(first.getUTCMonth() + 1);
  const last = new Date(next);
  last.setUTCDate(0);
  const to = last.toISOString().slice(0, 10);
  const previous = new Date(first);
  previous.setUTCMonth(first.getUTCMonth() - 1);
  return {
    from,
    to,
    label: monthFormat.format(first),
    leading: (first.getUTCDay() + 6) % 7,
    previous:
      first.getUTCFullYear() === 1 && first.getUTCMonth() === 0
        ? null
        : previous.toISOString().slice(0, 10),
    next: next.getUTCFullYear() > 9999 ? null : next.toISOString().slice(0, 10),
  };
}

export function timesheetHref({
  view,
  date,
  project,
  from,
  to,
  offset,
}: {
  view?: "list" | "calendar";
  date?: string | null;
  project?: string | null;
  from?: string;
  to?: string;
  offset?: number;
} = {}) {
  const query = new URLSearchParams();
  if (view === "list") query.set("view", view);
  if (date) query.set("date", date);
  if (project) query.set("project", project);
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  if (offset) query.set("offset", String(offset));
  return query.size ? `/timesheet?${query}` : "/timesheet";
}

export function countLabel(
  count: number,
  singular: string,
  plural = `${singular}s`,
) {
  return `${count.toLocaleString("en-GB")} ${count === 1 ? singular : plural}`;
}
