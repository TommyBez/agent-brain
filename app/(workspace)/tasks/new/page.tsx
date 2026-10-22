import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { TaskForm } from "@/components/tasks/task-form";
import { Button } from "@/components/ui/button";
import { Loading, PageHeading } from "@/components/workspace/primitives";
import { BrainError } from "@/lib/brain/types";
import { tasksEnabled } from "@/lib/tasks/types";
import { getWorkspacePage, getWorkspacePages } from "@/lib/workspace/data";
import { parseNewTaskParams } from "@/lib/workspace/task-urls";
import { getTaskFormChoices } from "@/lib/workspace/tasks-data";
import {
  CONNECTION_PAGE_SIZE,
  type RouteSearchParams,
  routeSearchParams,
} from "@/lib/workspace/urls";

export const metadata = { title: "New task · a native brain" };

type SearchParams = Promise<RouteSearchParams>;

async function NewTaskForm({ searchParams }: { searchParams: SearchParams }) {
  const { projectId } = parseNewTaskParams(
    routeSearchParams(await searchParams),
  );
  const [choices, projects, project] = await Promise.all([
    getTaskFormChoices(),
    getWorkspacePages({
      type: "project",
      sort: "title",
      limit: CONNECTION_PAGE_SIZE,
    }),
    projectId
      ? getWorkspacePage(projectId).catch((error) => {
          if (error instanceof BrainError) return null;
          throw error;
        })
      : null,
  ]);
  return (
    <TaskForm
      key={projectId}
      choices={choices}
      projectChoices={{
        pages: projects.pages.map(({ id, title }) => ({ id, title })),
        total: projects.total,
      }}
      initialProject={
        project?.type === "project"
          ? { id: project.id, title: project.title }
          : null
      }
    />
  );
}

export default function NewTaskPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  if (!tasksEnabled()) notFound();
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Button variant="ghost" asChild>
        <Link href="/tasks">
          <ArrowLeft size={16} /> Tasks
        </Link>
      </Button>
      <PageHeading
        eyebrow="Tasks"
        title="New task"
        description="Tasks you create are approved: any suitable agent may claim them, unless you delegate them to one."
      />
      <Suspense fallback={<Loading label="Opening the form…" />}>
        <NewTaskForm searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
