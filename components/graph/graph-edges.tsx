import { linkLabel } from "@/lib/graph/model";
import type { Point } from "@/lib/graph/view";
import type { GraphCanvasProps } from "./canvas-types";
import { round, towards } from "./render-utils";
export function GraphEdges({
  edges,
  nodes,
  positions,
  emphasized,
  emphasizedEdges,
  matched,
}: Pick<
  GraphCanvasProps,
  "edges" | "nodes" | "emphasized" | "emphasizedEdges" | "matched"
> & { positions: Record<string, Point> }) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return (
    <g>
      {edges.map((edge) => {
        const source = positions[edge.sourceId];
        const target = positions[edge.targetId];
        const sourceNode = nodeById.get(edge.sourceId);
        const targetNode = nodeById.get(edge.targetId);
        if (!source || !target || !sourceNode || !targetNode) return null;
        const active = emphasizedEdges.has(edge.id);
        const faded =
          !active &&
          (emphasized !== null ||
            (matched !== null &&
              !(matched.has(edge.sourceId) && matched.has(edge.targetId))));
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const length = Math.hypot(dx, dy) || 1;
        const bend = Math.min(28, length * 0.14) * (edge.lane + 1);
        const control = {
          x: (source.x + target.x) / 2 - (dy / length) * bend,
          y: (source.y + target.y) / 2 + (dx / length) * bend,
        };
        const start = towards(source, control, sourceNode.r + 1.5);
        const end = towards(target, control, targetNode.r + 2);
        const label = {
          x: 0.25 * start.x + 0.5 * control.x + 0.25 * end.x,
          y: 0.25 * start.y + 0.5 * control.y + 0.25 * end.y,
        };
        return (
          <g
            key={edge.id}
            style={{
              opacity: faded ? 0.1 : 1,
              transition: "opacity 150ms",
            }}
          >
            <path
              d={`M${round(start.x)} ${round(start.y)} Q${round(control.x)} ${round(control.y)} ${round(end.x)} ${round(end.y)}`}
              fill="none"
              className={active ? "stroke-primary" : "stroke-muted-foreground"}
              strokeOpacity={active ? 1 : 0.45}
              strokeWidth={active ? 2 : 1.2}
              strokeDasharray={edge.dash}
              strokeLinecap="round"
              markerEnd={
                edge.directed
                  ? `url(#${active ? "graph-arrow-active" : "graph-arrow"})`
                  : undefined
              }
            />
            {active && (
              <text
                x={round(label.x)}
                y={round(label.y - 4)}
                textAnchor="middle"
                fontSize={10}
                className="pointer-events-none fill-muted-foreground stroke-card font-sans"
                paintOrder="stroke"
                strokeWidth={4}
                strokeLinejoin="round"
              >
                {linkLabel(edge.type)}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}
