import { CalendarClock } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { requireTasksEnabled } from "@/app/(workspace)/tasks/enabled";
import { AgendaSeriesForm } from "@/components/tasks/agenda-series-form";
import { AgendaView } from "@/components/tasks/agenda-view";
import { TasksNav } from "@/components/tasks/tasks-nav";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, Loading, PageHeading } from "@/components/workspace/primitives";
import { formatTaskDate } from "@/lib/tasks/recurrences";
import { cn } from "@/lib/utils";
import {
  type RouteSearchParams,
  routeSearchParams,
} from "@/lib/workspace/urls";
import { getAgendaProjects, getAgendaView, getMeetingSeriesList } from "./data";

export const metadata = { title: "Agenda · a native brain" };

type SearchParams = Promise<RouteSearchParams>;

async function NewSeries() {
  const projects = await getAgendaProjects();
  return <AgendaSeriesForm projects={projects} />;
}

function NewSeriesSection({ open }: { open?: boolean }) {
  return (
    <details
      open={open}
      className="group rounded-2xl border bg-card px-5 py-4 sm:px-6"
    >
      <summary className="cursor-pointer text-sm font-medium">
        New meeting series
      </summary>
      <div className="pt-5">
        <Suspense fallback={<Skeleton className="h-40" />}>
          <NewSeries />
        </Suspense>
      </div>
    </details>
  );
}

async function AgendaPanel({ id }: { id: string }) {
  const view = await getAgendaView(id);
  if (!view)
    return (
      <Empty
        icon={<CalendarClock size={27} />}
        title="Meeting series not found"
        description="It may have been deleted. Choose another series."
      />
    );
  return <AgendaView agenda={view.agenda} markdown={view.markdown} />;
}

async function AgendaContent({ searchParams }: { searchParams: SearchParams }) {
  await requireTasksEnabled();
  const params = routeSearchParams(await searchParams);
  const series = await getMeetingSeriesList();
  if (!series.length)
    return (
      <div className="space-y-8">
        <Empty
          icon={<CalendarClock size={27} />}
          title="No meeting series yet"
          description="Add a recurring meeting for a project. Its agenda lists tasks due by the next meeting, overdue work and what closed since the last one."
        />
        <NewSeriesSection open />
      </div>
    );
  const selected =
    series.find((item) => item.id === params.get("series")) ?? series[0];
  return (
    <div className="space-y-10">
      {series.length > 1 && (
        <nav aria-label="Meeting series" className="flex flex-wrap gap-2">
          {series.map((item) => (
            <Link
              key={item.id}
              href={`/tasks/agenda?series=${item.id}`}
              aria-current={item.id === selected.id ? "page" : undefined}
              className={cn(
                "rounded-full border px-3 py-1.5 text-[13px] transition-colors",
                item.id === selected.id
                  ? "border-foreground bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.title}
              <span className="ml-2 text-xs text-muted-foreground">
                {item.nextMeeting ? formatTaskDate(item.nextMeeting) : "Paused"}
              </span>
            </Link>
          ))}
        </nav>
      )}
      <Suspense
        key={selected.id}
        fallback={<Loading label="Loading the agenda…" />}
      >
        <AgendaPanel id={selected.id} />
      </Suspense>
      <NewSeriesSection />
    </div>
  );
}

export default function AgendaPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <>
      <PageHeading
        eyebrow="Tasks"
        title="Agenda"
        description="The next meeting of a series: work due by then, overdue work and what closed since the last meeting."
      />
      <TasksNav />
      <Suspense fallback={<Loading label="Loading the agenda…" />}>
        <AgendaContent searchParams={searchParams} />
      </Suspense>
    </>
  );
}
