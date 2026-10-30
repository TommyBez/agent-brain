import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RelativeTime } from "@/components/workspace/relative-time";
import type { TaskRow } from "@/lib/workspace/task-queries";
import {
  nextSort,
  type TaskListFilters,
  type TaskSort,
  taskHref,
  taskListHref,
} from "@/lib/workspace/task-urls";
import { pageHref } from "@/lib/workspace/urls";
import { BLOCKED_REASON_LABELS, dueLabel } from "./labels";
import { LeaseCountdown } from "./lease-countdown";
import { AuthoredBy, PriorityLabel, StatusBadge } from "./status";

function SortHeader({
  label,
  sort,
  filters,
  className,
}: {
  label: string;
  sort: TaskSort;
  filters?: TaskListFilters;
  className?: string;
}) {
  if (!filters) return <TableHead className={className}>{label}</TableHead>;
  const active = filters.sort === sort;
  const Icon = !active
    ? ChevronsUpDown
    : filters.direction === "asc"
      ? ArrowUp
      : ArrowDown;
  return (
    <TableHead
      className={className}
      aria-sort={
        active
          ? filters.direction === "asc"
            ? "ascending"
            : "descending"
          : undefined
      }
    >
      <Link
        href={taskListHref({
          ...filters,
          ...nextSort(filters, sort),
          offset: 0,
        })}
        scroll={false}
        className="inline-flex items-center gap-1 hover:text-foreground"
      >
        {label}
        <Icon
          size={13}
          aria-hidden="true"
          className={active ? undefined : "opacity-40"}
        />
      </Link>
    </TableHead>
  );
}

/** Up to 50 tasks; with `filters`, the column headers sort the list. */
export function TaskTable({
  tasks,
  filters,
  caption,
}: {
  tasks: TaskRow[];
  filters?: TaskListFilters;
  caption: string;
}) {
  return (
    <Table className="min-w-[44rem]">
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <SortHeader
            label="Task"
            sort="number"
            filters={filters}
            className="w-[46%]"
          />
          <TableHead>Status</TableHead>
          <SortHeader label="Priority" sort="priority" filters={filters} />
          <SortHeader label="Due" sort="due" filters={filters} />
          <TableHead>Who</TableHead>
          <SortHeader label="Updated" sort="updated" filters={filters} />
        </TableRow>
      </TableHeader>
      <TableBody>
        {tasks.map((task) => {
          const due = dueLabel(task.due);
          return (
            <TableRow key={task.id}>
              <TableCell className="max-w-0 whitespace-normal">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                    {task.ref}
                  </span>
                  <Link
                    href={taskHref(task.ref)}
                    className="min-w-0 font-medium wrap-anywhere hover:underline"
                  >
                    {task.title.value}
                  </Link>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {task.project && (
                    <Link
                      href={pageHref(task.project.slug)}
                      className="wrap-anywhere hover:text-foreground"
                    >
                      {task.project.title}
                    </Link>
                  )}
                  {task.status === "blocked" && task.blockedReason && (
                    <span>
                      {
                        BLOCKED_REASON_LABELS[
                          task.blockedReason as keyof typeof BLOCKED_REASON_LABELS
                        ]
                      }
                    </span>
                  )}
                  {task.openBlockers > 0 && (
                    <span>
                      {task.openBlockers} open{" "}
                      {task.openBlockers === 1 ? "dependency" : "dependencies"}
                    </span>
                  )}
                  <AuthoredBy authored={task.title} />
                </div>
              </TableCell>
              <TableCell>
                <StatusBadge status={task.status} />
                {!task.approved &&
                  (task.status === "triage" || task.status === "ready") && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Not approved
                    </span>
                  )}
              </TableCell>
              <TableCell>
                <PriorityLabel priority={task.priority} />
              </TableCell>
              <TableCell className="whitespace-normal text-xs">
                {due ?? <span className="text-muted-foreground">—</span>}
              </TableCell>
              <TableCell className="whitespace-normal text-xs">
                {task.claimedBy && task.leaseExpiresAt ? (
                  <LeaseCountdown
                    expiresAt={task.leaseExpiresAt}
                    holder={task.claimedBy.label}
                  />
                ) : task.claimedBy ? (
                  task.claimedBy.label
                ) : task.delegate ? (
                  <span>For {task.delegate.label}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                <RelativeTime value={task.updatedAt} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
