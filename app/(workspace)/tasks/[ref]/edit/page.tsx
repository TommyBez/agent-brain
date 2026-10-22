import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AuthoredBy } from "@/components/tasks/status";
import {
  readTaskDetail,
  type TaskParams,
} from "@/components/tasks/task-detail";
import { TaskForm } from "@/components/tasks/task-form";
import { Button } from "@/components/ui/button";
import { Loading } from "@/components/workspace/primitives";
import { tasksEnabled } from "@/lib/tasks/types";
import { getWorkspacePages } from "@/lib/workspace/data";
import { taskHref } from "@/lib/workspace/task-urls";
import { getTaskFormChoices } from "@/lib/workspace/tasks-data";
import { CONNECTION_PAGE_SIZE } from "@/lib/workspace/urls";

export const metadata = { title: "Edit task · a native brain" };

async function EditTask({ params }: { params: TaskParams }) {
  const [{ task }, choices, projects] = await Promise.all([
    readTaskDetail(params),
    getTaskFormChoices(),
    getWorkspacePages({
      type: "project",
      sort: "title",
      limit: CONNECTION_PAGE_SIZE,
    }),
  ]);
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="font-mono text-xs text-muted-foreground">
          {task.ref} · version {task.version}
        </p>
        <h1 className="font-serif text-4xl tracking-[-0.04em]">Edit task</h1>
        <AuthoredBy authored={task.title} />
      </header>
      <TaskForm
        key={task.version}
        choices={choices}
        projectChoices={{
          pages: projects.pages.map(({ id, title }) => ({ id, title })),
          total: projects.total,
        }}
        task={{
          ref: task.ref,
          version: task.version,
          title: task.title.value,
          description: task.description.value,
          acceptanceCriteria: task.acceptanceCriteria.value,
          priority: task.priority,
          due: {
            kind: task.due.kind,
            on: task.due.on,
            at: task.due.at,
            text: task.due.text?.value ?? null,
          },
          project: task.project
            ? { id: task.project.id, title: task.project.title }
            : null,
          expectedOutput: task.expectedOutput,
          reviewPolicy: task.reviewPolicy,
          requiresHuman: task.requiresHuman,
          requiredCapability: task.requiredCapability,
          delegateId: task.delegateId,
          delegateLabel: task.delegate?.label ?? null,
        }}
      />
    </div>
  );
}

async function BackLink({ params }: { params: TaskParams }) {
  const { ref } = await params;
  return (
    <Button variant="ghost" asChild>
      <Link href={taskHref(ref)}>
        <ArrowLeft size={16} /> Back to the task
      </Link>
    </Button>
  );
}

export default function EditTaskPage({ params }: { params: TaskParams }) {
  if (!tasksEnabled()) notFound();
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Suspense
        fallback={
          <Button variant="ghost" asChild>
            <Link href="/tasks">
              <ArrowLeft size={16} /> Tasks
            </Link>
          </Button>
        }
      >
        <BackLink params={params} />
      </Suspense>
      <Suspense fallback={<Loading label="Opening the task…" />}>
        <EditTask params={params} />
      </Suspense>
    </div>
  );
}
