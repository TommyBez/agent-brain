import type { GraphNode } from "@/lib/graph/model";
import {
  type OverlayEdge,
  type OverlayTaskNode,
  TASK_NODE_SIZE,
  taskEdgeStyle,
} from "@/lib/graph/task-overlay";
import type { Point, View } from "@/lib/graph/view";
import type { TaskLayer } from "./canvas-types";
import { round, towards, truncate } from "./render-utils";
import { taskStatusIcon, taskStatusLabel } from "./task-status";

export function TaskOverlayEdges({
  layer,
  nodes,
  positions,
  taskPositions,
}: {
  layer: TaskLayer;
  nodes: GraphNode[];
  positions: Record<string, Point>;
  taskPositions: Record<string, Point>;
}) {
  const radius = new Map(nodes.map((node) => [node.id, node.r]));
  return (
    <g>
      {layer.edges.map((edge: OverlayEdge) => {
        const source = taskPositions[edge.taskId];
        const target = positions[edge.pageId];
        const r = radius.get(edge.pageId);
        if (!source || !target || r === undefined) return null;
        const style = taskEdgeStyle(edge);
        const lit = layer.focus?.edges.has(edge.id) ?? false;
        const faded = layer.focus !== null && !lit;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const length = Math.hypot(dx, dy) || 1;
        const bend = edge.lane * 12;
        const control = {
          x: (source.x + target.x) / 2 - (dy / length) * bend,
          y: (source.y + target.y) / 2 + (dx / length) * bend,
        };
        const start = towards(source, control, TASK_NODE_SIZE + 1);
        const end = towards(target, control, r + 2);
        const label = {
          x: 0.25 * start.x + 0.5 * control.x + 0.25 * end.x,
          y: 0.25 * start.y + 0.5 * control.y + 0.25 * end.y,
        };
        return (
          <g
            key={edge.id}
            style={{ opacity: faded ? 0.1 : 1, transition: "opacity 150ms" }}
          >
            <path
              d={`M${round(start.x)} ${round(start.y)} Q${round(control.x)} ${round(control.y)} ${round(end.x)} ${round(end.y)}`}
              fill="none"
              className="stroke-brand"
              strokeOpacity={lit ? Math.max(style.opacity, 0.7) : style.opacity}
              strokeWidth={lit ? style.width + 0.6 : style.width}
              strokeDasharray={style.dash}
              strokeLinecap="round"
            />
            {lit && length > 90 && (
              <text
                x={round(label.x)}
                y={round(label.y - 4)}
                textAnchor="middle"
                fontSize={10}
                className="pointer-events-none fill-brand stroke-card font-sans"
                paintOrder="stroke"
                strokeWidth={4}
                strokeLinejoin="round"
              >
                {style.label}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

export function TaskOverlayNodes({
  layer,
  taskPositions,
  view,
  onHover,
  onSelect,
}: {
  layer: TaskLayer;
  taskPositions: Record<string, Point>;
  view: View;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}) {
  const size = TASK_NODE_SIZE;
  return (
    <g>
      {layer.nodes.map((task: OverlayTaskNode) => {
        const position = taskPositions[task.id];
        if (!position) return null;
        const isSelected = layer.selected === task.id;
        const isHovered = layer.hovered === task.id;
        const lit = layer.focus?.tasks.has(task.id) ?? false;
        const dimmed = layer.focus !== null && !lit;
        const Icon = taskStatusIcon(task.status);
        const grow = isHovered ? 1.15 : 1;
        const half = size * grow;
        return (
          // biome-ignore lint/a11y/useSemanticElements: SVG nodes need an SVG group; the inspector offers equivalent buttons and links.
          <g
            key={task.id}
            data-task-id={task.id}
            role="button"
            tabIndex={0}
            aria-label={`Task ${task.ref}, ${task.title}, ${taskStatusLabel(task.status)}`}
            aria-pressed={isSelected}
            transform={`translate(${round(position.x)} ${round(position.y)})`}
            className="group cursor-pointer outline-none"
            style={{ opacity: dimmed ? 0.16 : 1, transition: "opacity 150ms" }}
            onPointerEnter={() => onHover(task.id)}
            onPointerLeave={() => onHover(null)}
            onFocus={() => onHover(task.id)}
            onBlur={() => onHover(null)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(task.id);
              }
            }}
          >
            {isSelected && (
              <rect
                x={-half - 9}
                y={-half - 9}
                width={(half + 9) * 2}
                height={(half + 9) * 2}
                rx={6}
                className="fill-brand"
                fillOpacity={0.1}
              />
            )}
            <rect
              x={-half - 4}
              y={-half - 4}
              width={(half + 4) * 2}
              height={(half + 4) * 2}
              rx={4}
              fill="none"
              className={
                isSelected
                  ? "stroke-primary"
                  : "stroke-ring opacity-0 group-focus-visible:opacity-100"
              }
              strokeWidth={2}
            />
            <rect
              x={-half - 8}
              y={-half - 8}
              width={(half + 8) * 2}
              height={(half + 8) * 2}
              className="fill-card"
              fillOpacity={0}
            />
            <rect
              x={-half}
              y={-half}
              width={half * 2}
              height={half * 2}
              rx={2.5}
              className="fill-brand-soft stroke-brand"
              strokeWidth={isSelected || isHovered ? 2 : 1.4}
            />
            <Icon
              x={-half * 0.75}
              y={-half * 0.75}
              width={half * 1.5}
              height={half * 1.5}
              strokeWidth={2.4}
              aria-hidden="true"
              className="pointer-events-none text-brand"
            />
            {(isSelected || isHovered || lit || view.k >= 1.2) && (
              <text
                y={-half - 12}
                textAnchor="middle"
                fontSize={10}
                className="pointer-events-none fill-brand stroke-card font-sans font-medium"
                paintOrder="stroke"
                strokeWidth={4}
                strokeLinejoin="round"
              >
                {isSelected || isHovered ? truncate(task.title) : task.ref}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

export function TaskTooltip({
  task,
  position,
  view,
}: {
  task: OverlayTaskNode;
  position: Point;
  view: View;
}) {
  return (
    <div
      role="presentation"
      className="pointer-events-none absolute z-10 max-w-60 -translate-x-1/2 -translate-y-full rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md [@media(pointer:coarse)]:hidden"
      style={{
        left: view.tx + position.x * view.k,
        top: view.ty + (position.y - TASK_NODE_SIZE) * view.k - 10,
      }}
    >
      <p className="truncate font-medium text-popover-foreground">
        <span className="font-mono text-muted-foreground">{task.ref}</span>{" "}
        {task.title}
      </p>
      <p className="text-muted-foreground">
        {taskStatusLabel(task.status)}
        {task.claimedBy ? ` · ${task.claimedBy}` : ""}
        {task.untrusted ? ` · written by ${task.authoredBy}` : ""}
      </p>
    </div>
  );
}
