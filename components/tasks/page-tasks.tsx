import { Columns3, ListTodo, Plus } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import {
  excludeFromKeeperAction,
  pauseProjectAction,
} from "@/app/(workspace)/actions/tasks";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { tasksEnabled } from "@/lib/tasks/types";
import type { TaskRow } from "@/lib/workspace/task-queries";
import {
  newTaskHref,
  taskBoardHref,
  taskHref,
  taskListHref,
} from "@/lib/workspace/task-urls";
import {
  getPersonTasks,
  getProjectTasks,
  getTaskSettingsView,
} from "@/lib/workspace/tasks-data";
import { ActionButton } from "./action-state";
import { dueLabel } from "./labels";
import { AuthoredBy, PriorityLabel, StatusBadge } from "./status";

function TaskList({
  tasks,
  roles,
}: {
  tasks: TaskRow[];
  roles?: Map<string, string[]>;
}) {
  return (
    <ul className="divide-y rounded-xl border bg-card">
      {tasks.map((task) => {
        const due = dueLabel(task.due);
        return (
          <li key={task.id} className="space-y-1 px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-mono text-xs text-muted-foreground">
                {task.ref}
              </span>
              <Link
                href={taskHref(task.ref)}
                className="min-w-0 flex-1 text-sm font-medium wrap-anywhere hover:underline"
              >
                {task.title.value}
              </Link>
              <StatusBadge status={task.status} />
            </div>
            <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
              <PriorityLabel priority={task.priority} />
              {due && <span>Due {due}</span>}
              {task.claimedBy && <span>{task.claimedBy.label} is on it</span>}
              {roles?.get(task.id) && (
                <span className="capitalize">
                  {roles.get(task.id)?.join(", ")}
                </span>
              )}
              <AuthoredBy authored={task.title} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

async function ProjectTasks({ pageId }: { pageId: string }) {
  const { tasks, total, paused } = await getProjectTasks(pageId);
  return (
    <section aria-labelledby="project-tasks" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="project-tasks" className="mr-auto font-serif text-2xl">
          Open tasks{" "}
          <span className="font-sans text-xs text-muted-foreground tabular-nums">
            {total}
          </span>
        </h2>
        <Button size="sm" asChild>
          <Link href={newTaskHref({ projectId: pageId })}>
            <Plus aria-hidden="true" /> New task in this project
          </Link>
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link href={taskBoardHref({ projectId: pageId })}>
            <Columns3 aria-hidden="true" /> Board
          </Link>
        </Button>
      </div>
      {tasks.length ? (
        <TaskList tasks={tasks} />
      ) : (
        <p className="text-sm text-muted-foreground">
          No open tasks. Work tracked for this project appears here.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        {total > tasks.length && (
          <Link
            href={taskListHref({ projectId: pageId })}
            className="text-muted-foreground hover:text-foreground"
          >
            <ListTodo size={14} className="mr-1 inline" aria-hidden="true" />
            Show all {total}
          </Link>
        )}
        <span className="text-muted-foreground">
          {paused
            ? "Paused: agents take its tasks only when you ask them."
            : "Agents may take approved tasks from the queue."}
        </span>
        <ActionButton
          size="sm"
          variant="ghost"
          errorClassName="basis-full"
          action={pauseProjectAction.bind(null, pageId, !paused)}
        >
          {paused ? "Resume project" : "Pause project"}
        </ActionButton>
      </div>
    </section>
  );
}

async function PersonTasks({ pageId }: { pageId: string }) {
  const { tasks, total } = await getPersonTasks(pageId);
  if (!tasks.length) return null;
  return (
    <section aria-labelledby="person-tasks" className="space-y-4">
      <h2 id="person-tasks" className="font-serif text-2xl">
        Tasks{" "}
        <span className="font-sans text-xs text-muted-foreground tabular-nums">
          {total}
        </span>
      </h2>
      <TaskList
        tasks={tasks}
        roles={new Map(tasks.map((task) => [task.id, task.roles]))}
      />
    </section>
  );
}

/** "Open tasks" on project pages and "Tasks" on person pages, suspended apart. */
export function PageTasks({ page }: { page: { id: string; type: string } }) {
  if (!tasksEnabled()) return null;
  if (page.type !== "project" && page.type !== "person") return null;
  return (
    <Suspense
      fallback={<Skeleton className="h-32" aria-label="Loading tasks" />}
    >
      {page.type === "project" ? (
        <ProjectTasks pageId={page.id} />
      ) : (
        <PersonTasks pageId={page.id} />
      )}
    </Suspense>
  );
}

async function KeeperSetting({ pageId }: { pageId: string }) {
  const settings = await getTaskSettingsView();
  const excluded = settings.keeperExcludedPageIds.includes(pageId);
  return (
    <>
      <dt className="font-medium">Task keeper</dt>
      <dd className="space-y-1 text-muted-foreground">
        <p>
          {excluded
            ? "Excluded: never read for tasks."
            : "Reads it for commitments."}
        </p>
        <ActionButton
          size="xs"
          variant="outline"
          errorClassName="basis-full"
          action={excludeFromKeeperAction.bind(null, pageId, !excluded)}
        >
          {excluded ? "Include again" : "Exclude from task keeper"}
        </ActionButton>
      </dd>
    </>
  );
}

/** Confidential pages can be kept away from task extraction. */
export function PageKeeperSetting({ pageId }: { pageId: string }) {
  if (!tasksEnabled()) return null;
  return (
    <Suspense>
      <KeeperSetting pageId={pageId} />
    </Suspense>
  );
}
