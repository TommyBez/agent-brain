import { ListTodo, Plus } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { NeedsYou, NeedsYouSkeleton } from "@/components/tasks/needs-you";
import { SavedViews } from "@/components/tasks/saved-views";
import { TaskFilters } from "@/components/tasks/task-filters";
import { TaskTable } from "@/components/tasks/task-table";
import { TasksNav } from "@/components/tasks/tasks-nav";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Pagination } from "@/components/workspace/pagination";
import { Empty, PageHeading } from "@/components/workspace/primitives";
import { BrainError } from "@/lib/brain/types";
import { tasksEnabled } from "@/lib/tasks/types";
import { getWorkspacePage } from "@/lib/workspace/data";
import {
  isFilteredTaskList,
  parseTaskListFilters,
  TASK_TABLE_PAGE_SIZE,
  type TaskListFilters,
  taskListHref,
} from "@/lib/workspace/task-urls";
import {
  getTaskFormChoices,
  getTaskOverview,
  getTaskSettingsView,
  getTaskTable,
} from "@/lib/workspace/tasks-data";
import {
  type RouteSearchParams,
  routeSearchParams,
} from "@/lib/workspace/urls";

export const metadata = { title: "Tasks · a native brain" };

type SearchParams = Promise<RouteSearchParams>;

function TableSkeleton() {
  return (
    <output aria-label="Loading tasks" className="block space-y-3">
      <Skeleton className="h-10" />
      <Skeleton className="h-64" />
    </output>
  );
}

async function Filters({ filters }: { filters: TaskListFilters }) {
  const [choices, project] = await Promise.all([
    getTaskFormChoices(),
    filters.projectId
      ? getWorkspacePage(filters.projectId).catch((error) => {
          if (error instanceof BrainError) return null;
          throw error;
        })
      : null,
  ]);
  return <TaskFilters agents={choices.agents} projectTitle={project?.title} />;
}

async function Views() {
  const settings = await getTaskSettingsView();
  return <SavedViews views={settings.savedViews} />;
}

function FilterBar({ filters }: { filters: TaskListFilters }) {
  return (
    <>
      <Suspense fallback={<Skeleton className="mb-5 h-10" />}>
        <Filters filters={filters} />
      </Suspense>
      <Suspense>
        <Views />
      </Suspense>
    </>
  );
}

async function FilteredTasks({ filters }: { filters: TaskListFilters }) {
  const { rows, total, hasMore } = await getTaskTable(filters);
  return (
    <section
      aria-label="Tasks"
      className="transition-opacity group-has-[[data-pending=true]]/tasks:opacity-50"
    >
      <p className="mb-3 text-xs text-muted-foreground tabular-nums">
        {total} {total === 1 ? "task" : "tasks"}
        {filters.offset > 0 &&
          ` · showing ${filters.offset + 1}–${filters.offset + rows.length}`}
      </p>
      {rows.length ? (
        <TaskTable tasks={rows} filters={filters} caption="Filtered tasks" />
      ) : (
        <Empty
          icon={<ListTodo size={27} />}
          title="No tasks match"
          description="Try other filters, or include done and canceled tasks."
        />
      )}
      <Pagination
        offset={filters.offset}
        hasMore={hasMore}
        pageSize={TASK_TABLE_PAGE_SIZE}
        href={(offset) => taskListHref({ ...filters, offset })}
        previousLabel="Previous"
        nextLabel="Next"
        label="Task pages"
      />
    </section>
  );
}

function OverviewSection({
  title,
  section,
  more,
}: {
  title: string;
  section: Awaited<ReturnType<typeof getTaskOverview>>["inProgress"];
  more: string;
}) {
  if (!section.total) return null;
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-medium">
          {title}{" "}
          <span className="text-xs font-normal text-muted-foreground tabular-nums">
            {section.total}
          </span>
        </h3>
        {section.total > section.rows.length && (
          <Link
            href={more}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Show all {section.total}
          </Link>
        )}
      </div>
      <TaskTable tasks={section.rows} caption={title} />
    </section>
  );
}

async function OpenSections() {
  const overview = await getTaskOverview();
  if (
    !overview.inProgress.total &&
    !overview.ready.total &&
    !overview.waiting.total
  )
    return (
      <Empty
        icon={<ListTodo size={27} />}
        title="No open work"
        description="Create a task, or ask an agent to track something for you."
      />
    );
  return (
    <div className="space-y-10">
      <OverviewSection
        title="In progress"
        section={overview.inProgress}
        more={taskListHref({ statuses: ["in_progress", "needs_input"] })}
      />
      <OverviewSection
        title="Ready"
        section={overview.ready}
        more={taskListHref({ statuses: ["ready"] })}
      />
      <OverviewSection
        title="Blocked and on hold"
        section={overview.waiting}
        more={taskListHref({ statuses: ["blocked", "on_hold"] })}
      />
    </div>
  );
}

async function TasksContent({ searchParams }: { searchParams: SearchParams }) {
  const filters = parseTaskListFilters(routeSearchParams(await searchParams));
  if (filters.view === "needs-you")
    return (
      <section aria-labelledby="needs-you-heading">
        <h2 id="needs-you-heading" className="sr-only">
          Needs you
        </h2>
        <NeedsYou />
      </section>
    );
  if (isFilteredTaskList(filters))
    return (
      <div className="group/tasks">
        <FilterBar filters={filters} />
        <Suspense fallback={<TableSkeleton />}>
          <FilteredTasks filters={filters} />
        </Suspense>
      </div>
    );
  return (
    <div className="space-y-14">
      <section aria-labelledby="needs-you-heading" className="space-y-5">
        <h2 id="needs-you-heading" className="font-serif text-2xl">
          Needs you
        </h2>
        <Suspense fallback={<NeedsYouSkeleton />}>
          <NeedsYou />
        </Suspense>
      </section>
      <section aria-labelledby="open-heading" className="group/tasks space-y-5">
        <h2 id="open-heading" className="font-serif text-2xl">
          Open tasks
        </h2>
        <FilterBar filters={filters} />
        <Suspense fallback={<TableSkeleton />}>
          <OpenSections />
        </Suspense>
      </section>
    </div>
  );
}

export default function TasksPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  if (!tasksEnabled()) notFound();
  return (
    <>
      <PageHeading
        eyebrow="Workspace"
        title="Tasks"
        description="Work you and your agents track. Agents claim tasks from their own sessions; decisions that need you come first."
      >
        <Button asChild>
          <Link href="/tasks/new">
            <Plus size={16} /> New task
          </Link>
        </Button>
      </PageHeading>
      <TasksNav />
      <Suspense fallback={<NeedsYouSkeleton />}>
        <TasksContent searchParams={searchParams} />
      </Suspense>
    </>
  );
}
