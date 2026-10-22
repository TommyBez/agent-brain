import { io } from "next/cache";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { OWNER_TIME_ZONE } from "@/components/tasks/labels";
import { TaskCalendar } from "@/components/tasks/task-calendar";
import { TasksNav } from "@/components/tasks/tasks-nav";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeading } from "@/components/workspace/primitives";
import { tasksEnabled } from "@/lib/tasks/types";
import {
  calendarFetchWindow,
  parseTaskCalendar,
} from "@/lib/workspace/task-urls";
import { getTaskCalendar } from "@/lib/workspace/tasks-data";
import {
  type RouteSearchParams,
  routeSearchParams,
} from "@/lib/workspace/urls";

export const metadata = { title: "Task calendar · a native brain" };

type SearchParams = Promise<RouteSearchParams>;

const ownerDay = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: OWNER_TIME_ZONE,
});

// Only a starting point for the fetch window when the URL names no date; the
// browser decides what today is. Read per request, never in a prerender.
async function requestDay() {
  await io();
  return ownerDay.format(new Date());
}

async function Calendar({ searchParams }: { searchParams: SearchParams }) {
  const state = parseTaskCalendar(routeSearchParams(await searchParams));
  const anchor = state.date ?? (await requestDay());
  const range = calendarFetchWindow(state, anchor);
  const { dated, loose } = await getTaskCalendar(range.from, range.to);
  return (
    <TaskCalendar
      state={state}
      serverToday={anchor}
      tasks={dated}
      loose={loose}
    />
  );
}

export default function TaskCalendarPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  if (!tasksEnabled()) notFound();
  return (
    <>
      <PageHeading
        eyebrow="Tasks"
        title="Calendar"
        description="Tasks by due date, in Europe/Rome. Done tasks stay visible, struck through."
      />
      <TasksNav />
      <Suspense
        fallback={
          <Skeleton className="h-[32rem]" aria-label="Loading the calendar" />
        }
      >
        <Calendar searchParams={searchParams} />
      </Suspense>
    </>
  );
}
