import type { GraphNode } from "@/lib/graph/model";
import type { Point, View } from "@/lib/graph/view";
export function GraphTooltip({
  node: hoveredNode,
  position: hoveredPosition,
  view,
}: {
  node: GraphNode;
  position: Point;
  view: View;
}) {
  return (
    <div
      role="presentation"
      className="pointer-events-none absolute z-10 max-w-56 -translate-x-1/2 -translate-y-full rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md [@media(pointer:coarse)]:hidden"
      style={{
        left: view.tx + hoveredPosition.x * view.k,
        top: view.ty + (hoveredPosition.y - hoveredNode.r) * view.k - 10,
      }}
    >
      <p className="truncate font-medium text-popover-foreground">
        {hoveredNode.title}
      </p>
      <p className="text-muted-foreground capitalize">
        {hoveredNode.type} · {hoveredNode.degree}{" "}
        {hoveredNode.degree === 1 ? "link" : "links"}
      </p>
    </div>
  );
}
