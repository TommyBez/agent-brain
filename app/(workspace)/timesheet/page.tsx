import { Clock3 } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { EntryActions, EntryForm } from "@/components/timesheet/entry-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Pagination } from "@/components/workspace/pagination";
import { Empty, Loading, PageHeading } from "@/components/workspace/primitives";
import { getTimesheet } from "@/lib/timesheet/data";
import { formatDuration, listTimeEntriesSchema } from "@/lib/timesheet/schemas";
import {
  pageHref,
  type RouteSearchParams,
  routeSearchParams,
} from "@/lib/workspace/urls";

export const metadata = { title: "Timesheet · a native brain" };

async function TimesheetContent({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const params = routeSearchParams(await searchParams);
  const parsed = listTimeEntriesSchema.safeParse({
    from: params.get("from") || undefined,
    to: params.get("to") || undefined,
    projectRef:
      params.get("project") === "none"
        ? null
        : params.get("project") || undefined,
    offset: Number(params.get("offset") || 0),
  });
  if (!parsed.success)
    return (
      <div role="alert" className="space-y-3">
        <p>Check the date range and filters.</p>
        <Button asChild variant="outline">
          <Link href="/timesheet">Reset filters</Link>
        </Button>
      </div>
    );
  const filters = parsed.data;
  const { entries, total, totalMinutes, nextOffset, projects } =
    await getTimesheet(filters);
  return (
    <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_340px]">
      <section aria-label="Recorded time" className="min-w-0 space-y-6">
        <form
          action="/timesheet"
          className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4"
        >
          <div className="space-y-2">
            <Label htmlFor="from">From</Label>
            <Input
              id="from"
              name="from"
              type="date"
              defaultValue={filters.from}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="to">To</Label>
            <Input id="to" name="to" type="date" defaultValue={filters.to} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="project">Project</Label>
            <NativeSelect
              id="project"
              name="project"
              defaultValue={
                filters.projectRef === null
                  ? "none"
                  : (filters.projectRef ?? "")
              }
            >
              <NativeSelectOption value="">All projects</NativeSelectOption>
              <NativeSelectOption value="none">No project</NativeSelectOption>
              {projects.map((project) => (
                <NativeSelectOption value={project.id} key={project.id}>
                  {project.title}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="outline">
              Filter
            </Button>
            <Button asChild variant="ghost">
              <Link href="/timesheet">Reset</Link>
            </Button>
          </div>
        </form>
        <div className="flex items-baseline justify-between gap-4 border-y py-5">
          <p className="text-sm text-muted-foreground">
            Total for this selection{" "}
            <span className="block text-xs">
              {total} {total === 1 ? "entry" : "entries"}
            </span>
          </p>
          <p className="font-serif text-3xl tabular-nums">
            {formatDuration(totalMinutes)}
          </p>
        </div>
        {entries.length ? (
          <ol className="divide-y">
            {entries.map((entry) => (
              <li key={entry.id} className="py-5 first:pt-0">
                <div className="flex items-baseline justify-between gap-4">
                  <time
                    dateTime={entry.workedOn}
                    className="text-sm font-medium"
                  >
                    {entry.workedOn}
                  </time>
                  <span className="font-medium tabular-nums">
                    {formatDuration(entry.minutes)}
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {entry.projectId ? (
                    <Link
                      href={pageHref(entry.projectId)}
                      className="hover:text-foreground"
                    >
                      {entry.projectTitle}
                    </Link>
                  ) : (
                    "No project"
                  )}
                </p>
                {entry.note && (
                  <p className="mt-3 whitespace-pre-wrap break-words text-sm">
                    {entry.note}
                  </p>
                )}
                <EntryActions entry={entry} projects={projects} />
              </li>
            ))}
          </ol>
        ) : (
          <Empty
            icon={<Clock3 />}
            title="No time recorded"
            description="Log your first entry, or change the filters to see other dates."
          />
        )}
        <Pagination
          offset={filters.offset}
          hasMore={nextOffset !== null}
          pageSize={filters.limit}
          href={(offset) => {
            const next = new URLSearchParams(params);
            next.set("offset", String(offset));
            return `/timesheet?${next}`;
          }}
        />
      </section>
      <section
        aria-labelledby="log-time-heading"
        className="h-fit rounded-xl border bg-card p-5 xl:sticky xl:top-6"
      >
        <h2 id="log-time-heading" className="mb-5 font-serif text-2xl">
          Log time
        </h2>
        <EntryForm projects={projects} />
      </section>
    </div>
  );
}

export default function TimesheetPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  return (
    <>
      <PageHeading
        eyebrow="Workspace"
        title="Timesheet"
        description="Keep track of your hours, with or without a project."
      >
        <Button asChild>
          <a href="#log-time-heading">Log time</a>
        </Button>
      </PageHeading>
      <Suspense fallback={<Loading label="Loading your timesheet…" />}>
        <TimesheetContent searchParams={searchParams} />
      </Suspense>
    </>
  );
}
