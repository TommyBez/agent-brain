import {
  LINK_TYPES,
  type LinkType,
  PAGE_TYPES,
  type PageType,
} from "../brain/types";
import { hashSeed } from "./layout";
import type { buildGraphModel } from "./model";
export function deriveGraphView(
  model: ReturnType<typeof buildGraphModel>,
  {
    hiddenTypes,
    hiddenLinkTypes,
    showUnlinked,
    query,
  }: {
    hiddenTypes: ReadonlySet<PageType>;
    hiddenLinkTypes: ReadonlySet<LinkType>;
    showUnlinked: boolean;
    query: string;
  },
  { trail, hovered }: { trail: string[]; hovered: string | null },
) {
  const seed = hashSeed(model.nodes.map((node) => node.id).join("|"));
  const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
  const visible: ReadonlySet<string> = new Set(
    model.nodes
      .filter(
        (node) =>
          !hiddenTypes.has(node.type) && (showUnlinked || !node.isolated),
      )
      .map((node) => node.id),
  );
  const edges = model.edges.filter(
    (edge) =>
      visible.has(edge.sourceId) &&
      visible.has(edge.targetId) &&
      !hiddenLinkTypes.has(edge.type),
  );
  const selectedId = trail.length ? trail[trail.length - 1] : null;
  const selected =
    selectedId && visible.has(selectedId)
      ? (nodeById.get(selectedId) ?? null)
      : null;
  const hoveredId = hovered && visible.has(hovered) ? hovered : null;

  const focusIds = [selected?.id, hoveredId].filter(
    (id): id is string => typeof id === "string",
  );
  let emphasized: ReadonlySet<string> | null = null;
  const emphasizedEdges = new Set<string>();
  if (focusIds.length) {
    const set = new Set(focusIds);
    for (const edge of edges) {
      if (
        focusIds.includes(edge.sourceId) ||
        focusIds.includes(edge.targetId)
      ) {
        set.add(edge.sourceId);
        set.add(edge.targetId);
        emphasizedEdges.add(edge.id);
      }
    }
    emphasized = set;
  }

  const normalizedQuery = query.trim().toLowerCase();
  const matches = normalizedQuery
    ? model.nodes.filter(
        (node) =>
          visible.has(node.id) &&
          [node.title, node.summary, ...node.aliases, ...node.tags].some(
            (value) => value.toLowerCase().includes(normalizedQuery),
          ),
      )
    : null;
  const matched: ReadonlySet<string> | null = matches
    ? new Set(matches.map((node) => node.id))
    : null;

  const typeCounts = PAGE_TYPES.map((type) => ({
    type,
    count: model.nodes.filter((node) => node.type === type).length,
  })).filter((item) => item.count > 0);
  const linkTypeCounts = LINK_TYPES.map((type) => ({
    type,
    count: model.edges.filter((edge) => edge.type === type).length,
  }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count);
  const unlinkedCount = model.nodes.filter((node) => node.isolated).length;
  const unlinkedVisibleCount = model.nodes.filter(
    (node) => node.isolated && visible.has(node.id),
  ).length;
  // The inspector only offers pages that are on screen, so selecting one
  // always resolves. Hidden relationship types still count as connections.
  const inspectorNodes = model.nodes.filter((node) => visible.has(node.id));
  const inspectorEdges = model.edges.filter(
    (edge) => visible.has(edge.sourceId) && visible.has(edge.targetId),
  );

  return {
    seed,
    visible,
    edges,
    selected,
    hoveredId,
    emphasized,
    emphasizedEdges,
    matches,
    matched,
    typeCounts,
    linkTypeCounts,
    unlinkedCount,
    unlinkedVisibleCount,
    inspectorNodes,
    inspectorEdges,
  };
}
