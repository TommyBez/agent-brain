import type { BrainLink, LinkType, PageSummary } from "@/lib/brain/types";
import { nodeRadius } from "./layout";

export interface GraphNode extends PageSummary {
  /** Links touching this page inside the loaded graph. */
  degree: number;
  /** No links inside the loaded graph while other pages are connected. */
  isolated: boolean;
  r: number;
  /** One of the most connected pages in the loaded graph. */
  hub: boolean;
}

export interface GraphEdge extends BrainLink {
  directed: boolean;
  dash?: string;
  /** Ordinal among parallel links between the same two pages. */
  lane: number;
}

export const HUB_LIMIT = 8;

export const linkStyles: Record<
  LinkType,
  { directed: boolean; dash?: string }
> = {
  works_at: { directed: true },
  owns: { directed: true },
  part_of: { directed: true },
  relates_to: { directed: false, dash: "5 4" },
  decided_in: { directed: true },
  references: { directed: true, dash: "2 4" },
  depends_on: { directed: true },
  supersedes: { directed: true, dash: "7 3" },
  collaborates_with: { directed: false },
};

export function linkLabel(type: string) {
  return type.replaceAll("_", " ");
}

export function buildGraphModel(graph: {
  nodes: PageSummary[];
  links: BrainLink[];
}): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const degree = new Map<string, number>();
  const lanes = new Map<string, number>();
  const edges: GraphEdge[] = [];
  for (const link of graph.links) {
    if (
      !ids.has(link.sourceId) ||
      !ids.has(link.targetId) ||
      link.sourceId === link.targetId
    )
      continue;
    degree.set(link.sourceId, (degree.get(link.sourceId) ?? 0) + 1);
    degree.set(link.targetId, (degree.get(link.targetId) ?? 0) + 1);
    const pair = [link.sourceId, link.targetId].sort().join("|");
    const lane = lanes.get(pair) ?? 0;
    lanes.set(pair, lane + 1);
    const style = linkStyles[link.type] ?? { directed: true };
    edges.push({ ...link, ...style, lane });
  }
  const connected = graph.nodes.filter((node) => degree.has(node.id)).length;
  const hubs = new Set(
    [...degree.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, HUB_LIMIT)
      .map(([id]) => id),
  );
  const nodes: GraphNode[] = graph.nodes.map((node) => {
    const count = degree.get(node.id) ?? 0;
    return {
      ...node,
      degree: count,
      isolated: connected > 0 && count === 0,
      r: nodeRadius(count),
      hub: hubs.has(node.id),
    };
  });
  return { nodes, edges };
}
