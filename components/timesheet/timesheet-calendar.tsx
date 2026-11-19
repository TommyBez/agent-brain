import { CalendarDays, ChevronLeft, ChevronRight, Clock3 } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/workspace/pagination";
import {
  countLabel,
  timesheetDayLabel,
  timesheetHref,
  timesheetMonth,
} from "@/lib/timesheet/calendar";
import { formatDuration, type TimeEntry } from "@/lib/timesheet/schemas";
import type { TimesheetDay } from "@/lib/timesheet/service";
import { cn } from "@/lib/utils";
import { EntryDialog, type ProjectChoice } from "./entry-form";
import { EntryList } from "./entry-list";

const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function TimesheetCalendar({
  date,
  today,
  project,
  projectId,
  projects,
  days,
  entries,
  offset,
  pageSize,
}: {
  date: string;
  today: string;
  project: string;
  projectId?: string;
  projects: ProjectChoice[];
  days: TimesheetDay[];
  entries: TimeEntry[];
  offset: number;
  pageSize: number;
}) {
  const month = timesheetMonth(date);
  const byDay = new Map(days.map((day) => [day.workedOn, day]));
  const detail = byDay.get(date);
  const hasMore = offset + entries.length < (detail?.total ?? 0);
  const minutes = days.reduce((sum, day) => sum + day.totalMinutes, 0);
  const count = days.reduce((sum, day) => sum + day.total, 0);
  const lastDay = Number(month.to.slice(8));
  const weeks = Math.ceil((month.leading + lastDay) / weekdays.length);
  const href = (day: string, offset?: number) =>
    timesheetHref({ date: day, project, offset });
  function monthHref(target: string) {
    return href(today.startsWith(target.slice(0, 7)) ? today : target);
  }

  return (
    <div className="grid items-start gap-4 min-[1200px]:grid-cols-[minmax(0,1fr)_minmax(280px,0.46fr)]">
      <section
        aria-labelledby="timesheet-month"
        className="min-w-0 overflow-hidden rounded-xl border bg-card"
      >
        <header className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-3.5 sm:px-5 sm:py-4">
          <h2
            id="timesheet-month"
            className="font-serif text-2xl leading-none tracking-tight sm:text-3xl"
          >
            {month.label}
          </h2>
          <nav aria-label="Calendar month" className="flex items-center gap-1">
            {month.previous ? (
              <Button
                asChild
                variant="ghost"
                size="icon"
                aria-label="Previous month"
              >
                <Link href={monthHref(month.previous)} scroll={false}>
                  <ChevronLeft />
                </Link>
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Previous month"
                disabled
              >
                <ChevronLeft />
              </Button>
            )}
            <Button asChild variant="outline" size="sm" className="shadow-none">
              <Link href={href(today)} scroll={false}>
                Today
              </Link>
            </Button>
            {month.next ? (
              <Button
                asChild
                variant="ghost"
                size="icon"
                aria-label="Next month"
              >
                <Link href={monthHref(month.next)} scroll={false}>
                  <ChevronRight />
                </Link>
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Next month"
                disabled
              >
                <ChevronRight />
              </Button>
            )}
          </nav>
        </header>
        <dl className="grid grid-cols-[1.35fr_1fr_1fr] divide-x border-y bg-muted/35">
          <div className="px-3.5 py-3 sm:px-5">
            <dt className="text-xs text-muted-foreground">Time logged</dt>
            <dd className="mt-1 font-serif text-2xl leading-none tabular-nums text-brand sm:text-3xl">
              {formatDuration(minutes)}
            </dd>
          </div>
          <div className="px-3.5 py-3 sm:px-5">
            <dt className="text-xs text-muted-foreground">Active days</dt>
            <dd className="mt-1 font-serif text-2xl leading-none tabular-nums sm:text-3xl">
              {days.length}
            </dd>
          </div>
          <div className="px-3.5 py-3 sm:px-5">
            <dt className="text-xs text-muted-foreground">Entries</dt>
            <dd className="mt-1 font-serif text-2xl leading-none tabular-nums sm:text-3xl">
              {count.toLocaleString("en-GB")}
            </dd>
          </div>
        </dl>
        <table className="w-full table-fixed border-collapse">
          <caption className="sr-only">
            Daily time totals for {month.label}
          </caption>
          <thead>
            <tr className="border-b">
              {weekdays.map((weekday, column) => (
                <th
                  key={weekday}
                  scope="col"
                  className={cn(
                    "px-0.5 py-2 text-center text-xs font-medium text-muted-foreground sm:px-3 sm:text-left",
                    column >= 5 && "bg-muted/30",
                  )}
                >
                  {weekday}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: weeks }, (_, week) => {
              const firstDay = week * weekdays.length - month.leading + 1;
              return (
                <tr key={firstDay} className="border-b last:border-b-0">
                  {weekdays.map((weekday, column) => {
                    const dayNumber = firstDay + column;
                    const day = `${month.from.slice(0, 7)}-${String(dayNumber).padStart(2, "0")}`;
                    const dayTotal = byDay.get(day);
                    const selected = date === day;
                    const isToday = day === today;
                    const outside = dayNumber < 1 || dayNumber > lastDay;
                    return (
                      <td
                        key={weekday}
                        className={cn(
                          "border-r p-0 align-top last:border-r-0",
                          (outside || column >= 5) && "bg-muted/30",
                        )}
                      >
                        {outside ? null : (
                          <Link
                            href={href(day)}
                            scroll={false}
                            prefetch={false}
                            aria-current={selected ? "true" : undefined}
                            aria-label={`${timesheetDayLabel(day)}${isToday ? ", today" : ""}, ${dayTotal ? formatDuration(dayTotal.totalMinutes) : "no time logged"}`}
                            className={cn(
                              "relative flex min-h-14 flex-col items-center gap-0.5 px-0.5 py-1.5 no-underline transition-colors hover:bg-accent/70 focus-visible:z-1 focus-visible:outline-offset-[-2px] sm:min-h-[4.75rem] sm:items-start sm:gap-1.5 sm:px-2 sm:py-2",
                              selected &&
                                "bg-brand-soft ring-1 ring-brand ring-inset hover:bg-brand-soft",
                            )}
                          >
                            <time
                              dateTime={day}
                              className={cn(
                                "flex size-6 items-center justify-center rounded-full text-xs font-medium tabular-nums sm:text-sm",
                                isToday && "bg-primary text-primary-foreground",
                              )}
                            >
                              {dayNumber}
                            </time>
                            {dayTotal && (
                              <span
                                className={cn(
                                  "max-w-full rounded-sm px-0.5 text-center text-[10px] leading-tight font-semibold wrap-anywhere tabular-nums text-brand sm:ml-1 sm:bg-brand-soft sm:px-1.5 sm:py-0.5 sm:text-xs",
                                  selected && "sm:bg-card",
                                )}
                              >
                                {formatDuration(dayTotal.totalMinutes)}
                              </span>
                            )}
                          </Link>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
      <section
        aria-labelledby="timesheet-day"
        className="min-w-0 rounded-xl border bg-card"
      >
        <header className="flex items-start justify-between gap-2 border-b px-4 py-4 sm:px-5">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <CalendarDays aria-hidden="true" className="size-3.5" />
              {date === today ? "Today" : "Selected day"}
            </div>
            <h2
              id="timesheet-day"
              aria-live="polite"
              className="mt-1 font-serif text-2xl leading-tight tracking-tight"
            >
              <time dateTime={date}>{timesheetDayLabel(date)}</time>
            </h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              <span className="font-semibold tabular-nums text-foreground">
                {formatDuration(detail?.totalMinutes ?? 0)}
              </span>
              {" · "}
              {countLabel(detail?.total ?? 0, "entry", "entries")}
            </p>
          </div>
          <div className="shrink-0 rounded-md border bg-background">
            <EntryDialog
              projects={projects}
              date={date}
              projectId={projectId}
              compact
            />
          </div>
        </header>
        {entries.length ? (
          <EntryList entries={entries} projects={projects} />
        ) : (
          <div className="flex items-center gap-3 px-4 py-6 text-sm text-muted-foreground sm:px-5">
            <Clock3 aria-hidden="true" className="size-5 shrink-0" />
            <p>
              {detail
                ? "No entries on this page."
                : "No time logged for this day."}
            </p>
          </div>
        )}
        {(offset > 0 || hasMore) && (
          <div className="px-4 pb-4 sm:px-5">
            <Pagination
              label="Entries for the selected day"
              offset={offset}
              hasMore={hasMore}
              pageSize={pageSize}
              href={(nextOffset) => href(date, nextOffset)}
              previousLabel="Previous"
              nextLabel="Next"
            />
          </div>
        )}
      </section>
    </div>
  );
}
