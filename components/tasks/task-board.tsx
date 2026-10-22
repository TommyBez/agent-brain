"use client";

import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/utils/combine";
import { ArrowRightLeft, GripVertical } from "lucide-react";
import Link from "next/link";
import {
  startTransition,
  useEffect,
  useEffectEvent,
  useOptimistic,
  useRef,
  useState,
} from "react";
import {
  moveTaskAction,
  type TaskActionError,
} from "@/app/(workspace)/actions/tasks";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { refreshTaskSignals } from "@/hooks/use-live-refresh";
import type { TaskStatus } from "@/lib/tasks/types";
import { cn } from "@/lib/utils";
import type { TaskRow } from "@/lib/workspace/task-queries";
import {
  type TaskBoardFilters,
  taskHref,
  taskListHref,
} from "@/lib/workspace/task-urls";
import { ActionError } from "./action-state";
import { dueLabel, statusLabel } from "./labels";
import { LeaseCountdown } from "./lease-countdown";
import { MoveDialog, type MoveInput } from "./move-dialog";
import { PriorityLabel, STATUS_TEXT } from "./status";
import {
  BOARD_COLUMNS,
  boardMove,
  boardMoveTargets,
  MENU_TARGETS,
  MOVE_INPUT,
  moveAnnouncement,
} from "./transitions";

type DragData = { type: "task"; id: string; status: string; approved: boolean };

const isTaskDrag = (data: Record<string | symbol, unknown>): data is DragData =>
  data.type === "task" && typeof data.id === "string";

function TaskCard({
  task,
  onMove,
}: {
  task: TaskRow;
  onMove: (task: TaskRow, to: TaskStatus) => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const [dragging, setDragging] = useState(false);
  const targets = boardMoveTargets(task, BOARD_COLUMNS);
  // Canceling has no column; the menu still offers it.
  const menu = boardMoveTargets(task, MENU_TARGETS);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return draggable({
      element,
      canDrag: () => targets.length > 0,
      getInitialData: (): DragData => ({
        type: "task",
        id: task.id,
        status: task.status,
        approved: task.approved,
      }),
      onDragStart: () => setDragging(true),
      onDrop: () => setDragging(false),
    });
  }, [task.id, task.status, task.approved, targets.length]);
  const due = dueLabel(task.due);
  return (
    <li
      ref={ref}
      className={cn(
        "space-y-2 rounded-lg border bg-card p-3 text-sm shadow-xs",
        targets.length > 0 && "cursor-grab active:cursor-grabbing",
        dragging && "opacity-40",
      )}
    >
      <div className="flex items-start gap-2">
        {targets.length > 0 && (
          <GripVertical
            size={14}
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-muted-foreground"
          />
        )}
        <div className="min-w-0 flex-1">
          <span className="font-mono text-xs text-muted-foreground">
            {task.ref}
          </span>{" "}
          <Link
            href={taskHref(task.ref)}
            draggable={false}
            className="font-medium wrap-anywhere hover:underline"
          >
            {task.title.value}
          </Link>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <PriorityLabel priority={task.priority} />
        {due && <span>{due}</span>}
        {task.project && (
          <span className="wrap-anywhere">{task.project.title}</span>
        )}
        {!task.approved && task.status !== "done" && <span>Not approved</span>}
      </div>
      {task.claimedBy && task.leaseExpiresAt && (
        <LeaseCountdown
          expiresAt={task.leaseExpiresAt}
          holder={task.claimedBy.label}
        />
      )}
      {menu.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="xs" variant="ghost" className="-ml-1.5">
              <ArrowRightLeft aria-hidden="true" />
              Move to…
              <span className="sr-only"> {task.ref}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Move {task.ref} to</DropdownMenuLabel>
            {menu.map((target) => (
              <DropdownMenuItem
                key={target.status}
                onSelect={() => onMove(task, target.status)}
              >
                {statusLabel(target.status)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

function Column({
  status,
  tasks,
  hidden,
  more,
  dragged,
  onMove,
}: {
  status: TaskStatus;
  tasks: TaskRow[];
  /** Tasks of this column the board did not load. */
  hidden: number;
  more: string;
  dragged: DragData | null;
  onMove: (task: TaskRow, to: TaskStatus) => void;
}) {
  const count = tasks.length + hidden;
  const ref = useRef<HTMLElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return dropTargetForElements({
      element,
      getData: () => ({ status }),
      canDrop: ({ source }) =>
        isTaskDrag(source.data) && boardMove(source.data, status) !== null,
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: () => setOver(false),
    });
  }, [status]);
  const allowed = dragged ? boardMove(dragged, status) !== null : false;
  return (
    <section
      ref={ref}
      aria-label={`${statusLabel(status)}, ${count} ${count === 1 ? "task" : "tasks"}`}
      className={cn(
        "flex w-72 shrink-0 flex-col gap-3 rounded-xl border border-transparent bg-muted/60 p-3 transition-colors",
        dragged && allowed && "border-dashed border-ring/60",
        dragged && !allowed && dragged.status !== status && "opacity-50",
        over && "border-solid border-ring bg-accent",
      )}
    >
      <h2 className="flex items-center justify-between px-1 text-sm font-medium">
        <span className={STATUS_TEXT[status]}>{statusLabel(status)}</span>
        <span className="text-xs font-normal text-muted-foreground tabular-nums">
          {count}
        </span>
      </h2>
      <ul className="flex min-h-24 flex-col gap-2">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} onMove={onMove} />
        ))}
      </ul>
      {hidden > 0 && (
        <p className="px-1 text-xs text-muted-foreground">
          {hidden} more not shown.{" "}
          <Link href={more} className="underline underline-offset-4">
            See all in the table
          </Link>
        </p>
      )}
    </section>
  );
}

/**
 * Columns by status. Dropping a card, or "Move to…" from its menu, runs the
 * matching owner transition; the move shows at once and reverts if the
 * server refuses it (for example, an agent claimed the task meanwhile).
 * A crowded column shows its first cards and how many more there are.
 */
export function TaskBoard({
  tasks,
  totals = {},
  filters = { projectId: "", query: "" },
}: {
  tasks: TaskRow[];
  totals?: Partial<Record<string, number>>;
  filters?: TaskBoardFilters;
}) {
  const [board, applyMove] = useOptimistic(
    tasks,
    (current, move: { id: string; status: TaskStatus }) =>
      current.map((task) =>
        task.id === move.id ? { ...task, status: move.status } : task,
      ),
  );
  const [error, setError] = useState<TaskActionError | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [dragged, setDragged] = useState<DragData | null>(null);
  const [asking, setAsking] = useState<{
    task: TaskRow;
    to: TaskStatus;
    need: "reason" | "note";
  } | null>(null);

  function commit(task: TaskRow, to: TaskStatus, input: MoveInput = {}) {
    setError(null);
    startTransition(async () => {
      applyMove({ id: task.id, status: to });
      const result = await moveTaskAction(task.ref, task.status, to, {
        expectedVersion: task.version,
        claimCount: task.claimCount,
        ...input,
      });
      if (!result.ok) {
        setError(result);
        setAnnouncement(`${task.ref} stayed in ${statusLabel(task.status)}.`);
        return;
      }
      // A released claim returns where it started, which may not be `to`.
      const actual = result.value.status;
      if (actual !== to)
        startTransition(() =>
          applyMove({ id: task.id, status: actual as TaskStatus }),
        );
      refreshTaskSignals({ silent: true });
      setAnnouncement(moveAnnouncement(task.ref, to, actual));
    });
  }

  function requestMove(task: TaskRow, to: TaskStatus) {
    const op = boardMove(task, to);
    if (!op) return;
    const need = MOVE_INPUT[op];
    if (need) setAsking({ task, to, need });
    else commit(task, to);
  }

  const onDrop = useEffectEvent((id: string, to: TaskStatus) => {
    const task = board.find((item) => item.id === id);
    if (task) requestMove(task, to);
  });

  useEffect(
    () =>
      combine(
        monitorForElements({
          canMonitor: ({ source }) => isTaskDrag(source.data),
          onDragStart: ({ source }) =>
            setDragged(isTaskDrag(source.data) ? source.data : null),
          onDrop: ({ source, location }) => {
            setDragged(null);
            const target = location.current.dropTargets[0];
            const status = target?.data.status;
            if (isTaskDrag(source.data) && typeof status === "string")
              onDrop(source.data.id, status as TaskStatus);
          },
        }),
      ),
    [],
  );

  return (
    <div className="space-y-3">
      <ActionError error={error} />
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div className="relative -mx-5 overflow-x-auto px-5 pb-4 md:-mx-10 md:px-10 xl:-mx-14 xl:px-14">
        <div className="flex gap-3">
          {BOARD_COLUMNS.map((status) => (
            <Column
              key={status}
              status={status}
              dragged={dragged}
              tasks={board.filter((task) => task.status === status)}
              hidden={Math.max(
                0,
                (totals[status] ?? 0) -
                  tasks.filter((task) => task.status === status).length,
              )}
              more={taskListHref({
                statuses: [status],
                projectId: filters.projectId,
                query: filters.query,
              })}
              onMove={requestMove}
            />
          ))}
        </div>
      </div>
      <MoveDialog
        need={asking?.need ?? null}
        taskRef={asking?.task.ref ?? ""}
        onCancel={() => setAsking(null)}
        onConfirm={(input) => {
          if (asking) commit(asking.task, asking.to, input);
          setAsking(null);
        }}
      />
    </div>
  );
}
