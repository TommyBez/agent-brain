import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { TaskLiveRefresh } from "@/components/tasks/live-refresh";
import {
  TaskDangerZone,
  TaskDescription,
  TaskHeader,
  TaskHistory,
  TaskKnowledge,
  TaskOwnerPanels,
  type TaskParams,
  TaskProperties,
  TaskRefLabel,
  TaskSuggestions,
} from "@/components/tasks/task-detail";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Loading } from "@/components/workspace/primitives";
import { tasksEnabled } from "@/lib/tasks/types";

export const metadata = { title: "Task · a native brain" };

export default function TaskPage({ params }: { params: TaskParams }) {
  if (!tasksEnabled()) notFound();
  return (
    <div className="mx-auto max-w-[1100px] space-y-8">
      <TaskLiveRefresh />
      <div className="flex flex-wrap items-center justify-between gap-4 text-[10px] text-muted-foreground">
        <Button variant="ghost" asChild>
          <Link href="/tasks">
            <ArrowLeft size={16} /> Tasks
          </Link>
        </Button>
        <Suspense fallback={<span>TASK</span>}>
          <TaskRefLabel params={params} />
        </Suspense>
      </div>
      <Suspense
        fallback={<Skeleton className="h-48" aria-label="Loading the task" />}
      >
        <TaskHeader params={params} />
      </Suspense>
      <Suspense>
        <TaskOwnerPanels params={params} />
      </Suspense>
      <div className="grid grid-cols-1 items-start gap-12 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 space-y-12">
          <Suspense fallback={<Loading label="Loading the description…" />}>
            <TaskDescription params={params} />
          </Suspense>
          <Suspense fallback={<Skeleton className="h-32" />}>
            <TaskKnowledge params={params} />
          </Suspense>
          <Suspense>
            <TaskSuggestions params={params} />
          </Suspense>
          <Suspense fallback={<Skeleton className="h-40" />}>
            <TaskHistory params={params} />
          </Suspense>
        </div>
        <Suspense fallback={<Skeleton className="h-80" />}>
          <TaskProperties params={params} />
        </Suspense>
      </div>
      <Suspense>
        <TaskDangerZone params={params} />
      </Suspense>
    </div>
  );
}
