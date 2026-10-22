import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { type ReactNode, Suspense } from "react";
import { RequireTasks } from "@/app/(workspace)/tasks/enabled";
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

export const metadata = { title: "Task · a native brain" };

// Each section reads the task only once the owner's task manager is confirmed
// on; while it is off they all end in the 404 instead.
function TaskSection({
  fallback,
  children,
}: {
  fallback?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Suspense fallback={fallback}>
      <RequireTasks>{children}</RequireTasks>
    </Suspense>
  );
}

export default function TaskPage({ params }: { params: TaskParams }) {
  return (
    <div className="mx-auto max-w-[1100px] space-y-8">
      <TaskSection>
        <TaskLiveRefresh />
      </TaskSection>
      <div className="flex flex-wrap items-center justify-between gap-4 text-[10px] text-muted-foreground">
        <Button variant="ghost" asChild>
          <Link href="/tasks">
            <ArrowLeft size={16} /> Tasks
          </Link>
        </Button>
        <TaskSection fallback={<span>TASK</span>}>
          <TaskRefLabel params={params} />
        </TaskSection>
      </div>
      <TaskSection
        fallback={<Skeleton className="h-48" aria-label="Loading the task" />}
      >
        <TaskHeader params={params} />
      </TaskSection>
      <TaskSection>
        <TaskOwnerPanels params={params} />
      </TaskSection>
      <div className="grid grid-cols-1 items-start gap-12 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 space-y-12">
          <TaskSection fallback={<Loading label="Loading the description…" />}>
            <TaskDescription params={params} />
          </TaskSection>
          <TaskSection fallback={<Skeleton className="h-32" />}>
            <TaskKnowledge params={params} />
          </TaskSection>
          <TaskSection>
            <TaskSuggestions params={params} />
          </TaskSection>
          <TaskSection fallback={<Skeleton className="h-40" />}>
            <TaskHistory params={params} />
          </TaskSection>
        </div>
        <TaskSection fallback={<Skeleton className="h-80" />}>
          <TaskProperties params={params} />
        </TaskSection>
      </div>
      <TaskSection>
        <TaskDangerZone params={params} />
      </TaskSection>
    </div>
  );
}
