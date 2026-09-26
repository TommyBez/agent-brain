import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  GraphInspector,
  type GraphInspectorProps,
} from "../components/graph/graph-inspector";
import type { GraphEdge, GraphNode } from "../lib/graph/model";

function node(id: string): GraphNode {
  return {
    id,
    slug: id,
    title: id,
    type: "note",
    summary: "",
    aliases: [],
    tags: [],
    version: 1,
    createdAt: "2026-09-26",
    updatedAt: "2026-09-26",
    embeddedAt: null,
    degree: 1,
    isolated: false,
    r: 12,
    hub: false,
  };
}

const selected = node("selected");
const loaded = node("loaded");
const noop = () => {};

function render(edges: GraphEdge[]) {
  const props: GraphInspectorProps = {
    nodes: [selected, loaded],
    edges,
    selected,
    canGoBack: false,
    onSelect: noop,
    onBack: noop,
    onClear: noop,
    typeCounts: [],
    hiddenTypes: new Set(),
    onToggleType: noop,
    linkTypeCounts: [],
    hiddenLinkTypes: new Set(),
    onToggleLinkType: noop,
    unlinkedCount: 0,
    unlinkedVisibleCount: 0,
    showUnlinked: true,
    onToggleUnlinked: noop,
    visibleCount: 2,
    visibleLinkCount: edges.length,
  };
  return renderToStaticMarkup(createElement(GraphInspector, props));
}

for (const direction of ["Outgoing", "Incoming", "Linked"] as const) {
  test(`inspector ${direction.toLowerCase()} connections omit endpoints absent from the supplied nodes`, () => {
    const edge = (otherId: string): GraphEdge => ({
      id: `${direction}-${otherId}`,
      sourceId: direction === "Incoming" ? otherId : selected.id,
      targetId: direction === "Incoming" ? selected.id : otherId,
      type: direction === "Linked" ? "relates_to" : "references",
      directed: direction !== "Linked",
      label: "",
      lane: 0,
    });
    const html = render([edge(loaded.id), edge("missing")]);
    assert.match(html, /CONNECTIONS · 1/);
    assert.match(html, new RegExp(`${direction} · 1`));
    assert.match(html, /aria-label="Open loaded"/);
    assert.doesNotMatch(html, /Open missing|\/pages\/missing/);

    const empty = render([edge("missing")]);
    assert.match(empty, /CONNECTIONS · 0/);
    assert.match(empty, /No links to other loaded pages/);
  });
}
