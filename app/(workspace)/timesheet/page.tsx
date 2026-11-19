import { CalendarDays, Clock3, List } from "lucide-react";
import { io } from "next/cache";
import Link from "next/link";
import { Suspense } from "react";
import { EntryDialog } from "@/components/timesheet/entry-form";
import { EntriesByDay } from "@/components/timesheet/entry-list";
import { TimesheetFilters } from "@/components/timesheet/filters";
import { TimesheetCalendar } from "@/components/timesheet/timesheet-calendar";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { Pagination } from "@/components/workspace/pagination";
import { Empty, Loading } from "@/components/workspace/primitives";
import { BrainError } from "@/lib/brain/types";
import {
  countLabel,
  isTimesheetDate,
  timesheetHref,
  timesheetMonth,
  timesheetToday,
} from "@/lib/timesheet/calendar";
import { getTimesheet, getTimesheetMonth } from "@/lib/timesheet/data";
import { formatDuration, listTimeEntriesSchema } from "@/lib/timesheet/schemas";
import {
  type RouteSearchParams,
  routeSearchParams,
} from "@/lib/workspace/urls";

export const metadata = { title: "Timesheet · a native brain" };

type View = "calendar" | "list";

function TimesheetHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header className="mb-6 flex items-center justify-between gap-3 sm:mb-8">
      <h1 className="font-serif text-4xl font-normal tracking-[-0.045em] sm:text-5xl lg:text-[3.5rem]">
        Timesheet
      </h1>
      {children}
    </header>
  );
}

function InvalidFilters({ view, message }: { view: View; message: string }) {
  return (
    <>
      <TimesheetHeader />
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4 text-sm"
      >
        <p>{message}</p>
        <Button asChild variant="outline" size="sm">
          <Link href={timesheetHref({ view })}>Reset filters</Link>
        </Button>
      </div>
    </>
  );
}

function ViewSwitch({
  view,
  date,
  project,
}: {
  view: View;
  date: string;
  project: string;
}) {
  return (
    <nav
      aria-label="Timesheet view"
      className="flex w-fit shrink-0 items-center gap-0.5 rounded-lg border bg-muted/50 p-0.5"
    >
      {(
        [
          { id: "calendar", label: "Calendar", icon: CalendarDays },
          { id: "list", label: "List", icon: List },
        ] as const
      ).map(({ id, label, icon: Icon }) => (
        <Button
          key={id}
          asChild
          variant="ghost"
          size="sm"
          className="text-muted-foreground aria-[current=page]:bg-card aria-[current=page]:text-foreground aria-[current=page]:shadow-xs"
        >
          {view === id ? (
            <span aria-current="page">
              <Icon aria-hidden="true" />
              {label}
            </span>
          ) : (
            <Link href={timesheetHref({ view: id, date, project })}>
              <Icon aria-hidden="true" />
              {label}
            </Link>
          )}
        </Button>
      ))}
    </nav>
  );
}

async function TimesheetContent({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const params = routeSearchParams(await searchParams);
  // Older links with a custom range still open the filtered list.
  const view: View =
    params.get("view") === "list" ||
    (!params.has("view") && (params.has("from") || params.has("to")))
      ? "list"
      : "calendar";
  const dateParam = params.get("date");
  const projectParam = params.get("project");
  const from = view === "list" ? params.get("from") || undefined : undefined;
  const to = view === "list" ? params.get("to") || undefined : undefined;
  const parsed = listTimeEntriesSchema.safeParse({
    from,
    to,
    projectRef: projectParam === "none" ? null : projectParam || undefined,
    offset: Number(params.get("offset") || 0),
  });

  if (
    !parsed.success ||
    (dateParam && !isTimesheetDate(dateParam)) ||
    (from && !isTimesheetDate(from)) ||
    (to && !isTimesheetDate(to))
  ) {
    return (
      <InvalidFilters
        view={view}
        message="Check the dates and filters, then try again."
      />
    );
  }

  await io();
  const today = timesheetToday();
  const date = dateParam || today;
  const filters = parsed.data;

  try {
    if (view === "calendar") {
      const { from, to } = timesheetMonth(date);
      const { entries, days, filterProjects, projects, project, projectId } =
        await getTimesheetMonth({ ...filters, from, to, day: date });
      return (
        <>
          <TimesheetHeader>
            <EntryDialog
              projects={projects}
              date={date}
              projectId={projectId}
            />
          </TimesheetHeader>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <ViewSwitch view={view} date={date} project={project} />
            <TimesheetFilters
              view={view}
              date={dateParam}
              project={project}
              projects={filterProjects}
            />
          </div>
          <TimesheetCalendar
            date={date}
            today={today}
            project={project}
            projectId={projectId}
            projects={projects}
            days={days}
            entries={entries}
            offset={filters.offset}
            pageSize={filters.limit}
          />
        </>
      );
    }

    const {
      entries,
      total,
      totalMinutes,
      nextOffset,
      filterProjects,
      projects,
      project,
      projectId,
    } = await getTimesheet(filters);
    const filtersActive = Boolean(from || to || project);
    return (
      <>
        <TimesheetHeader>
          <EntryDialog projects={projects} date={today} projectId={projectId} />
        </TimesheetHeader>
        <div className="space-y-4">
          <ViewSwitch view={view} date={date} project={project} />
          <TimesheetFilters
            view={view}
            date={dateParam}
            project={project}
            from={from}
            to={to}
            projects={filterProjects}
          />
          <section aria-labelledby="logged-entries" className="space-y-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-b px-1 py-4">
              <div>
                <h2 id="logged-entries" className="font-serif text-2xl">
                  Time entries
                </h2>
                <p className="text-sm text-muted-foreground">
                  {countLabel(total, "entry", "entries")}
                </p>
              </div>
              <div className="flex items-baseline gap-2 text-muted-foreground">
                <span className="text-xs">Total</span>
                <span className="font-serif text-3xl leading-none tabular-nums text-brand">
                  {formatDuration(totalMinutes)}
                </span>
              </div>
            </div>
            {entries.length ? (
              <EntriesByDay entries={entries} projects={projects} />
            ) : (
              <Empty
                icon={<Clock3 />}
                title={total ? "No entries on this page" : "No time recorded"}
                description={
                  total
                    ? "Go back to see more entries."
                    : filtersActive
                      ? "Try changing the date range or project."
                      : "Log your first time entry to get started."
                }
              />
            )}
            <Pagination
              offset={filters.offset}
              hasMore={nextOffset !== null}
              pageSize={filters.limit}
              href={(offset) =>
                timesheetHref({
                  view,
                  date: dateParam,
                  project,
                  from,
                  to,
                  offset,
                })
              }
            />
          </section>
        </div>
      </>
    );
  } catch (error) {
    if (error instanceof BrainError && error.code === "PROJECT_NOT_FOUND") {
      return (
        <InvalidFilters
          view={view}
          message="This project is unavailable. Reset the filter to see your timesheet."
        />
      );
    }
    throw error;
  }
}

export default function TimesheetPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  return (
    <>
      <Suspense
        fallback={
          <>
            <TimesheetHeader />
            <Loading label="Loading your timesheet…" />
          </>
        }
      >
        <TimesheetContent searchParams={searchParams} />
      </Suspense>
      <Toaster />
    </>
  );
}
