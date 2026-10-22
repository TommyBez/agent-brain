import { Plus } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { requireTasksEnabled } from "@/app/(workspace)/tasks/enabled";
import { BoardFilters } from "@/components/tasks/board-filters";
import { TaskBoard } from "@/components/tasks/task-board";
import { TasksNav } from "@/components/tasks/tasks-nav";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeading } from "@/components/workspace/primitives";
import { newTaskHref, parseTaskBoardFilters } from "@/lib/workspace/task-urls";
import { getTaskBoard } from "@/lib/workspace/tasks-data";
import {
  type RouteSearchParams,
  routeSearchParams,
} from "@/lib/workspace/urls";

export const metadata = { title: "Task board · a native brain" };

type SearchParams = Promise<RouteSearchParams>;

async function Board({ searchParams }: { searchParams: SearchParams }) {
  await requireTasksEnabled();
  const filters = parseTaskBoardFilters(routeSearchParams(await searchParams));
  const { tasks, totals } = await getTaskBoard(filters);
  return <TaskBoard tasks={tasks} totals={totals} filters={filters} />;
}

function BoardSkeleton() {
  return (
    <output
      aria-label="Loading the board"
      className="flex gap-3 overflow-hidden"
    >
      {[1, 2, 3, 4].map((column) => (
        <Skeleton key={column} className="h-96 w-72 shrink-0" />
      ))}
    </output>
  );
}

export default function TaskBoardPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <>
      <PageHeading
        eyebrow="Tasks"
        title="Board"
        description="Drag a card, or use its “Move to…” menu, to run the owner transition for that column. Done shows the last 14 days."
      >
        <Button asChild>
          <Link href={newTaskHref()}>
            <Plus size={16} /> New task
          </Link>
        </Button>
      </PageHeading>
      <TasksNav />
      <Suspense>
        <BoardFilters />
      </Suspense>
      <Suspense fallback={<BoardSkeleton />}>
        <Board searchParams={searchParams} />
      </Suspense>
    </>
  );
}
