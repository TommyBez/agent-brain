"use client";

import {
  addMonths,
  addWeeks,
  format,
  isSameMonth,
  parseISO,
  startOfMonth,
} from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { startTransition, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TaskRow } from "@/lib/workspace/task-queries";
import {
  calendarRange,
  type TaskCalendarState,
  taskCalendarHref,
  taskHref,
} from "@/lib/workspace/task-urls";
import { dueDay, dueLabel, OWNER_TIME_ZONE } from "./labels";
import { PriorityLabel, StatusBadge } from "./status";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_LIMIT = 3;
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: OWNER_TIME_ZONE,
});

function browserToday() {
  return format(new Date(), "yyyy-MM-dd");
}

function TaskChip({ task }: { task: TaskRow }) {
  const closed = task.status === "done";
  return (
    <Link
      href={taskHref(task.ref)}
      className={cn(
        "block truncate rounded-md border bg-card px-1.5 py-0.5 text-xs hover:border-foreground/40",
        closed && "text-muted-foreground line-through",
      )}
      title={task.title.value}
    >
      {task.due.at && (
        <span className="mr-1 tabular-nums text-muted-foreground">
          {timeFormat.format(new Date(task.due.at))}
        </span>
      )}
      {task.title.value}
    </Link>
  );
}

/**
 * Typed deadlines by day in the owner's time zone. "Today" is the browser's,
 * so the server never guesses the viewer's date.
 */
export function TaskCalendar({
  state,
  serverToday,
  tasks,
  loose,
}: {
  state: TaskCalendarState;
  serverToday: string;
  tasks: TaskRow[];
  loose: TaskRow[];
}) {
  const [today, setToday] = useState<string | null>(null);
  useEffect(() => {
    startTransition(() => setToday(browserToday()));
  }, []);
  const anchor = state.date ?? today ?? serverToday;
  const { days } = calendarRange(state.mode, anchor);
  const byDay = new Map<string, TaskRow[]>();
  for (const task of tasks) {
    const day = dueDay(task.due);
    if (day) byDay.set(day, [...(byDay.get(day) ?? []), task]);
  }
  const anchorDate = parseISO(anchor);
  const step = (direction: 1 | -1) =>
    format(
      state.mode === "week"
        ? addWeeks(anchorDate, direction)
        : startOfMonth(addMonths(anchorDate, direction)),
      "yyyy-MM-dd",
    );
  const title =
    state.mode === "week"
      ? `Week of ${format(parseISO(days[0]), "d MMM yyyy")}`
      : format(anchorDate, "MMMM yyyy");
  const visible = days.filter((day) => byDay.has(day));

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-serif text-2xl">{title}</h2>
        <Button variant="outline" size="icon" asChild>
          <Link
            href={taskCalendarHref({ mode: state.mode, date: step(-1) })}
            aria-label={
              state.mode === "week" ? "Previous week" : "Previous month"
            }
          >
            <ChevronLeft />
          </Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href={taskCalendarHref({ mode: state.mode })}>Today</Link>
        </Button>
        <Button variant="outline" size="icon" asChild>
          <Link
            href={taskCalendarHref({ mode: state.mode, date: step(1) })}
            aria-label={state.mode === "week" ? "Next week" : "Next month"}
          >
            <ChevronRight />
          </Link>
        </Button>
        <div className="flex rounded-md border p-0.5">
          {(["month", "week"] as const).map((mode) => (
            <Button
              key={mode}
              size="sm"
              variant={state.mode === mode ? "secondary" : "ghost"}
              aria-current={state.mode === mode ? "page" : undefined}
              asChild
            >
              <Link href={taskCalendarHref({ mode, date: state.date })}>
                {mode === "month" ? "Month" : "Week"}
              </Link>
            </Button>
          ))}
        </div>
      </div>

      <table className="hidden w-full table-fixed border-collapse md:table">
        <caption className="sr-only">Deadlines, {title}</caption>
        <thead>
          <tr>
            {WEEKDAYS.map((weekday) => (
              <th
                key={weekday}
                scope="col"
                className="pb-2 text-left text-xs font-medium text-muted-foreground"
              >
                {weekday}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: days.length / 7 }, (_, week) =>
            days.slice(week * 7, week * 7 + 7),
          ).map((week) => (
            <tr key={week[0]}>
              {week.map((day) => {
                const items = byDay.get(day) ?? [];
                const shown =
                  state.mode === "week" ? items : items.slice(0, MONTH_LIMIT);
                const outside =
                  state.mode === "month" &&
                  !isSameMonth(parseISO(day), anchorDate);
                return (
                  <td
                    key={day}
                    className={cn(
                      "h-28 border p-1.5 align-top",
                      state.mode === "week" && "h-64",
                      outside && "bg-muted/40",
                    )}
                  >
                    <div
                      className={cn(
                        "mb-1 flex size-6 items-center justify-center rounded-full text-xs tabular-nums",
                        outside && "text-muted-foreground",
                        day === today && "bg-primary text-primary-foreground",
                      )}
                    >
                      <time dateTime={day}>{format(parseISO(day), "d")}</time>
                      {day === today && (
                        <span className="sr-only"> (today)</span>
                      )}
                    </div>
                    <div className="space-y-1">
                      {shown.map((task) => (
                        <TaskChip key={task.id} task={task} />
                      ))}
                      {items.length > shown.length && (
                        <Link
                          href={taskCalendarHref({ mode: "week", date: day })}
                          className="block text-xs text-muted-foreground hover:text-foreground"
                        >
                          +{items.length - shown.length} more
                        </Link>
                      )}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <section
        aria-label={`Deadlines, ${title}`}
        className="space-y-4 md:hidden"
      >
        {visible.length ? (
          visible.map((day) => (
            <div key={day} className="space-y-2">
              <h3 className="text-sm font-medium">
                {format(parseISO(day), "EEEE d MMMM")}
                {day === today && " · today"}
              </h3>
              <div className="space-y-1">
                {(byDay.get(day) ?? []).map((task) => (
                  <TaskChip key={task.id} task={task} />
                ))}
              </div>
            </div>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">
            No deadlines in this {state.mode}.
          </p>
        )}
      </section>

      <section aria-labelledby="loose-deadlines" className="space-y-3">
        <h2 id="loose-deadlines" className="font-medium">
          Approximate and event deadlines
        </h2>
        {loose.length ? (
          <ul className="divide-y rounded-xl border bg-card">
            {loose.map((task) => (
              <li
                key={task.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {task.ref}
                </span>
                <Link
                  href={taskHref(task.ref)}
                  className="min-w-0 flex-1 font-medium wrap-anywhere hover:underline"
                >
                  {task.title.value}
                </Link>
                <span className="text-xs">{dueLabel(task.due)}</span>
                <PriorityLabel priority={task.priority} compact />
                <StatusBadge status={task.status} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            None. Deadlines written as “end of October” or “next meeting” keep
            their wording and appear here.
          </p>
        )}
      </section>
    </div>
  );
}
