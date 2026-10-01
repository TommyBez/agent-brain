import type { Ref } from "react";
import type { LayoutInputLink } from "@/lib/graph/layout";
import type { GraphEdge, GraphNode } from "@/lib/graph/model";
export interface GraphCanvasHandle {
  fit(): void;
  zoomBy(factor: number): void;
  focusNode(id: string): void;
  shake(): void;
}

export interface GraphCanvasProps {
  ref: Ref<GraphCanvasHandle>;
  /** Every loaded page; visibility is decided by `visible`. */
  nodes: GraphNode[];
  /** Every loaded link, so hiding a relationship type keeps the layout stable. */
  layoutLinks: LayoutInputLink[];
  /** Links to draw. */
  edges: GraphEdge[];
  visible: ReadonlySet<string>;
  selected: string | null;
  hovered: string | null;
  /** Pages kept bright while something is selected or hovered; null when nothing is. */
  emphasized: ReadonlySet<string> | null;
  emphasizedEdges: ReadonlySet<string>;
  /** Search matches; null when there is no query. */
  matched: ReadonlySet<string> | null;
  seed: number;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  onOpen: (id: string) => void;
}
