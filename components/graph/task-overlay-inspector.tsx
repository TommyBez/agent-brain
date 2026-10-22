import { ArrowUpRight, X } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { GraphNode } from "@/lib/graph/model";
import {
  type OverlayEdge,
  type OverlayLinkRole,
  type OverlayTaskNode,
  taskEdgeStyle,
  taskHref,
  taskLinkStyles,
} from "@/lib/graph/task-overlay";
import type { TaskLayer } from "./canvas-types";
import { NodeButton, SectionTitle } from "./inspector-parts";
import { taskStatusIcon, taskStatusLabel } from "./task-status";

const LEGEND_ROLES: OverlayLinkRole[] = [
  "project",
  "context",
  "decision",
  "source",
  "stakeholder",
  "produced",
];

function TaskButton({
  task,
  caption,
  onSelect,
}: {
  task: OverlayTaskNode;
  caption: string;
  onSelect: (id: string) => void;
}) {
  const Icon = taskStatusIcon(task.status);
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onSelect(task.id)}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-sm border border-brand bg-brand-soft text-brand">
          <Icon className="size-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-foreground">{task.title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {caption}
          </span>
        </span>
      </button>
      <Button variant="ghost" size="icon-sm" asChild>
        <Link href={taskHref(task.ref)} aria-label={`Open ${task.ref}`}>
          <ArrowUpRight />
        </Link>
      </Button>
    </div>
  );
}

function roles(edges: OverlayEdge[]) {
  return edges.map((edge) => taskEdgeStyle(edge).label).join(", ");
}

/** The open tasks linked to the selected page. */
export function PageTasks({
  pageId,
  layer,
  onSelectTask,
}: {
  pageId: string;
  layer: TaskLayer;
  onSelectTask: (id: string) => void;
}) {
  const tasks = layer.nodes.flatMap((task) => {
    const edges = layer.edges.filter(
      (edge) => edge.taskId === task.id && edge.pageId === pageId,
    );
    return edges.length ? [{ task, edges }] : [];
  });
  return (
    <>
      <Separator />
      <div className="space-y-2">
        <SectionTitle>OPEN TASKS · {tasks.length}</SectionTitle>
        {tasks.length ? (
          <div className="space-y-0.5">
            {tasks.map(({ task, edges }) => (
              <TaskButton
                key={task.id}
                task={task}
                caption={`${task.ref} · ${taskStatusLabel(task.status)} · ${roles(edges)}`}
                onSelect={onSelectTask}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No open task is linked to this page.
          </p>
        )}
      </div>
    </>
  );
}

export function TaskDetails({
  task,
  layer,
  nodes,
  onSelect,
  onClear,
}: {
  task: OverlayTaskNode;
  layer: TaskLayer;
  nodes: GraphNode[];
  onSelect: (id: string) => void;
  onClear: () => void;
}) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const byPage = new Map<string, OverlayEdge[]>();
  for (const edge of layer.edges)
    if (edge.taskId === task.id)
      byPage.set(edge.pageId, [...(byPage.get(edge.pageId) ?? []), edge]);
  const pages = [...byPage].flatMap(([pageId, edges]) => {
    const node = nodeById.get(pageId);
    return node ? [{ node, edges }] : [];
  });
  const Icon = taskStatusIcon(task.status);
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-2">
        <Badge variant="outline">
          <Icon aria-hidden="true" /> {taskStatusLabel(task.status)}
        </Badge>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Clear selection"
          onClick={onClear}
        >
          <X />
        </Button>
      </div>
      <div className="space-y-2">
        <p className="font-mono text-xs text-muted-foreground">{task.ref}</p>
        <h2 className="wrap-anywhere font-serif text-2xl leading-tight">
          {task.title}
        </h2>
        <p className="text-xs text-muted-foreground">
          {task.untrusted
            ? `Written by ${task.authoredBy}`
            : `Created by ${task.authoredBy}`}
          {task.claimedBy ? ` · claimed by ${task.claimedBy}` : ""}
        </p>
      </div>
      <Button asChild>
        <Link href={taskHref(task.ref)}>
          Open task <ArrowUpRight />
        </Link>
      </Button>
      <Separator />
      <div className="space-y-2">
        <SectionTitle>KNOWLEDGE IN VIEW · {pages.length}</SectionTitle>
        <div className="space-y-0.5">
          {pages.map(({ node, edges }) => (
            <NodeButton
              key={node.id}
              node={node}
              caption={roles(edges)}
              onSelect={onSelect}
            />
          ))}
        </div>
        <p className="px-2 text-xs text-muted-foreground">
          Only pages loaded in the graph appear here. Open the task for every
          link.
        </p>
      </div>
    </div>
  );
}

/** Counts and the line legend, shown in the overview while the layer is on. */
export function TaskOverlaySummary({
  layer,
  loaded,
  total,
}: {
  layer: TaskLayer;
  loaded: number;
  total: number;
}) {
  return (
    <>
      <Separator />
      <div className="space-y-2">
        <SectionTitle>OPEN TASKS · {layer.nodes.length}</SectionTitle>
        <p className="text-xs text-muted-foreground">
          {total > loaded
            ? `${total} open tasks are linked to these pages; the ${loaded} most urgent are drawn.`
            : "Open tasks linked to the pages in view. Tasks are not pages and do not count toward them."}
        </p>
        <ul className="space-y-1.5">
          {LEGEND_ROLES.map((role) => (
            <li
              key={role}
              className="flex items-center gap-2.5 text-sm text-muted-foreground"
            >
              <svg
                aria-hidden="true"
                width="28"
                height="8"
                className="shrink-0"
              >
                <line
                  x1="1"
                  y1="4"
                  x2="27"
                  y2="4"
                  className="stroke-brand"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  strokeDasharray={taskLinkStyles[role].dash}
                />
              </svg>
              {taskLinkStyles[role].label}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Faded lines are suggested links waiting for your review.
        </p>
      </div>
    </>
  );
}
