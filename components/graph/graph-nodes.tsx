import { typeIcons } from "@/components/workspace/primitives";
import type { GraphNode } from "@/lib/graph/model";
import type { Point, View } from "@/lib/graph/view";
import type { GraphCanvasProps } from "./canvas-types";
import { round, truncate } from "./render-utils";
export function GraphNodes({
  nodes,
  positions,
  visible,
  selected,
  hovered,
  emphasized,
  matched,
  view,
  dragging,
  onHover,
  onSelect,
}: Pick<
  GraphCanvasProps,
  | "nodes"
  | "visible"
  | "selected"
  | "hovered"
  | "emphasized"
  | "matched"
  | "onHover"
  | "onSelect"
> & { positions: Record<string, Point>; view: View; dragging: string | null }) {
  const showsAllLabels = visible.size <= 30;
  // An active search outranks selection: matches stay bright wherever they sit.
  const isDimmed = (id: string) =>
    matched !== null
      ? !matched.has(id) && id !== selected
      : emphasized !== null && !emphasized.has(id);
  const showsLabel = (node: GraphNode) =>
    showsAllLabels ||
    node.hub ||
    selected === node.id ||
    hovered === node.id ||
    (emphasized?.has(node.id) ?? false) ||
    (matched?.has(node.id) ?? false) ||
    view.k >= (node.isolated ? 1.3 : 0.8);
  return (
    <g>
      {nodes.map((node) => {
        if (!visible.has(node.id)) return null;
        const position = positions[node.id];
        if (!position) return null;
        const Icon = typeIcons[node.type];
        const isSelected = selected === node.id;
        const isHovered = hovered === node.id || dragging === node.id;
        const isMatched = matched?.has(node.id) ?? false;
        const radius = node.r * (isHovered ? 1.12 : 1);
        const iconSize = Math.max(8, radius * 1.15);
        return (
          // biome-ignore lint/a11y/useSemanticElements: SVG nodes need an SVG group; the inspector offers equivalent buttons and links.
          <g
            key={node.id}
            data-node-id={node.id}
            role="button"
            tabIndex={0}
            aria-label={`${node.title}, ${node.type}, ${node.degree} ${node.degree === 1 ? "connection" : "connections"}`}
            aria-pressed={isSelected}
            transform={`translate(${round(position.x)} ${round(position.y)})`}
            className={`entity-${node.type} group outline-none ${dragging === node.id ? "cursor-grabbing" : "cursor-grab"}`}
            style={{
              opacity: isDimmed(node.id) ? 0.16 : 1,
              transition: "opacity 150ms",
            }}
            onPointerEnter={() => onHover(node.id)}
            onPointerLeave={() => onHover(null)}
            onFocus={() => onHover(node.id)}
            onBlur={() => onHover(null)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(node.id);
              }
            }}
          >
            {isSelected && (
              <circle
                r={radius + 12}
                className="fill-primary"
                fillOpacity={0.1}
              />
            )}
            {(isSelected || isMatched) && (
              <circle
                r={radius + 5}
                fill="none"
                className="stroke-primary"
                strokeWidth={isSelected ? 2 : 1.5}
                strokeDasharray={isSelected ? undefined : "3 3"}
              />
            )}
            <circle
              r={radius + 5}
              fill="none"
              className="stroke-ring opacity-0 group-focus-visible:opacity-100"
              strokeWidth={2}
            />
            <circle r={radius + 9} className="fill-card" fillOpacity={0} />
            <circle
              r={radius}
              className="fill-secondary stroke-secondary-foreground"
              strokeWidth={isSelected || isHovered ? 2.5 : 1.5}
            />
            <Icon
              x={-iconSize / 2}
              y={-iconSize / 2}
              width={iconSize}
              height={iconSize}
              strokeWidth={2.2}
              aria-hidden="true"
              className="pointer-events-none text-secondary-foreground"
            />
            {showsLabel(node) && (
              <text
                y={radius + 14}
                textAnchor="middle"
                fontSize={11}
                className={`fill-foreground stroke-card font-sans ${isSelected || isHovered ? "font-semibold" : "font-medium"}`}
                paintOrder="stroke"
                strokeWidth={4}
                strokeLinejoin="round"
              >
                {truncate(node.title)}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}
