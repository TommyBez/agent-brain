import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  GraphInspector,
  type GraphInspectorProps,
} from "../components/graph/graph-inspector";
import type { BrainLink, PageSummary } from "../lib/brain/types";
import { deriveGraphView } from "../lib/graph/derive-view";
import { createLayout } from "../lib/graph/layout";
import { buildGraphModel } from "../lib/graph/model";
import {
  deriveTaskOverlay,
  type OverlayLink,
  type OverlayTask,
  overlayEmphasis,
  parseTaskOverlayParam,
  placeTaskNodes,
  TASK_NODE_SIZE,
  TASK_ORBIT,
  type TaskOverlay,
  taskEdgeStyle,
  taskHref,
  withTaskOverlay,
} from "../lib/graph/task-overlay";
import { GRAPH_PAGE_SIZE, graphHref } from "../lib/workspace/urls";

function page(id: string): PageSummary {
  return {
    id,
    slug: `note/${id}`,
    title: `Page ${id}`,
    type: "note",
    summary: "",
    relationships: [],
    aliases: [],
    tags: [],
    version: 1,
    createdAt: "2026-10-21",
    updatedAt: "2026-10-21",
    embeddedAt: null,
  };
}

function task(id: string, fields: Partial<OverlayTask> = {}): OverlayTask {
  return {
    id,
    ref: `T-${id.replace(/\D/g, "") || 1}`,
    title: `Task ${id}`,
    authoredBy: "Codex",
    untrusted: true,
    status: "ready",
    priority: 2,
    claimedBy: null,
    ...fields,
  };
}

const link = (
  taskId: string,
  pageId: string,
  role: OverlayLink["role"] = "context",
  status: OverlayLink["status"] = "active",
): OverlayLink => ({ taskId, pageId, role, status });

const viewOptions = {
  hiddenTypes: new Set<never>(),
  hiddenLinkTypes: new Set<never>(),
  showUnlinked: true,
  query: "",
};

test("only tasks anchored by an active link or project to a visible page are drawn", () => {
  const overlay: TaskOverlay = {
    tasks: [
      task("t1"),
      task("t2"),
      task("t3"),
      task("t4"),
      task("t5", { status: "in_progress" }),
    ],
    links: [
      link("t1", "a"),
      link("t1", "a", "decision", "suggested"),
      link("t1", "b", "source"),
      link("t1", "hidden"),
      link("t2", "b", "context", "suggested"),
      link("t3", "hidden"),
      link("t4", "c", "project"),
      link("t5", "a", "produced"),
      link("t5", "b", "stakeholder", "suggested"),
    ],
    total: 5,
  };
  const { nodes, edges } = deriveTaskOverlay(overlay, new Set(["a", "b", "c"]));
  assert.deepEqual(
    nodes.map((node) => [node.id, node.anchors]),
    [
      ["t1", ["a", "b"]],
      ["t4", ["c"]],
      ["t5", ["a"]],
    ],
    "Suggested links alone and hidden pages never bring a task into view",
  );
  assert.deepEqual(
    edges.map((edge) => [edge.id, edge.lane]),
    [
      ["t1|a|context", 0],
      ["t1|a|decision", 1],
      ["t1|b|source", 0],
      ["t4|c|project", 0],
      ["t5|a|produced", 0],
      ["t5|b|stakeholder", 0],
    ],
  );
  assert.equal(
    edges.some((edge) => edge.pageId === "hidden" || edge.taskId === "t2"),
    false,
  );
});

test("the task layer never consumes the 150-page window, the page layout or its counts", () => {
  const pages = Array.from({ length: GRAPH_PAGE_SIZE }, (_, index) =>
    page(`p${index}`),
  );
  const links: BrainLink[] = pages.slice(1).map((item, index) => ({
    id: `l${index}`,
    sourceId: pages[index].id,
    targetId: item.id,
    type: "relates_to",
    label: "",
  }));
  const graph = { nodes: pages, links };
  const before = buildGraphModel(graph);
  const overlay: TaskOverlay = {
    tasks: Array.from({ length: 300 }, (_, index) => task(`t${index}`)),
    links: Array.from({ length: 300 }, (_, index) =>
      link(`t${index}`, pages[index % pages.length].id),
    ),
    total: 300,
  };
  const frozen = structuredClone(overlay);
  const view = deriveGraphView(before, viewOptions, {
    trail: [],
    hovered: null,
  });
  const layer = deriveTaskOverlay(overlay, view.visible);
  const after = buildGraphModel(graph);
  const viewAfter = deriveGraphView(after, viewOptions, {
    trail: [],
    hovered: null,
  });
  assert.equal(layer.nodes.length, 300);
  assert.equal(after.nodes.length, GRAPH_PAGE_SIZE);
  assert.deepEqual(after, before);
  assert.equal(viewAfter.visible.size, GRAPH_PAGE_SIZE);
  assert.equal(viewAfter.edges.length, links.length);
  assert.deepEqual(viewAfter.typeCounts, [
    { type: "note", count: GRAPH_PAGE_SIZE },
  ]);
  assert.deepEqual(overlay, frozen, "Derivation leaves its input untouched");
  const pageIds = new Set(after.nodes.map((node) => node.id));
  assert.ok(layer.nodes.every((node) => !pageIds.has(node.id)));
  const layout = createLayout(after.nodes, after.edges, view.seed);
  assert.equal(layout.nodes.length, GRAPH_PAGE_SIZE);
});

test("tasks orbit a single page or sit between several, deterministically", () => {
  const positions = {
    a: { x: 0, y: 0 },
    b: { x: 200, y: 0 },
  };
  const radius = (id: string) => (id === "a" ? 10 : 14);
  const { nodes } = deriveTaskOverlay(
    {
      tasks: [task("t1"), task("t2"), task("t3"), task("t4")],
      links: [
        link("t1", "a"),
        link("t2", "a", "source"),
        link("t3", "a"),
        link("t3", "b", "project"),
        link("t4", "missing"),
      ],
      total: 4,
    },
    new Set(["a", "b", "missing"]),
  );
  const placed = placeTaskNodes(nodes, positions, radius);
  assert.deepEqual(placeTaskNodes(nodes, positions, radius), placed);
  assert.equal(placed.t4, undefined, "No position for an unplaced page");
  for (const id of ["t1", "t2"]) {
    const distance = Math.hypot(placed[id].x, placed[id].y);
    assert.ok(Math.abs(distance - (10 + TASK_ORBIT)) < 1e-9);
    assert.ok(distance > 10 + TASK_NODE_SIZE);
    assert.ok(placed[id].y < 0, "Above the page, clear of its label");
  }
  assert.ok(
    Math.hypot(placed.t1.x - placed.t2.x, placed.t1.y - placed.t2.y) > 20,
    "Tasks around one page do not overlap",
  );
  assert.deepEqual(placed.t3, { x: 100, y: 0 });
});

test("focus lights a task's pages, or the tasks of focused pages", () => {
  const { edges } = deriveTaskOverlay(
    {
      tasks: [task("t1"), task("t2")],
      links: [link("t1", "a"), link("t1", "b"), link("t2", "b")],
      total: 2,
    },
    new Set(["a", "b"]),
  );
  assert.equal(overlayEmphasis(edges, [], []), null);
  const byTask = overlayEmphasis(edges, ["t1"], ["b"]);
  assert.deepEqual([...(byTask?.pages ?? [])], ["a", "b"]);
  assert.deepEqual([...(byTask?.tasks ?? [])], ["t1"]);
  assert.equal(byTask?.edges.size, 2);
  const byPage = overlayEmphasis(edges, [], ["b"]);
  assert.deepEqual([...(byPage?.tasks ?? [])].sort(), ["t1", "t2"]);
  assert.equal(byPage?.pages.size, 0);
  assert.deepEqual([...(byPage?.edges ?? [])].sort(), [
    "t1|b|context",
    "t2|b|context",
  ]);
});

test("edge styles depend on role and status", () => {
  const active = taskEdgeStyle({ role: "decision", status: "active" });
  const suggested = taskEdgeStyle({ role: "decision", status: "suggested" });
  assert.equal(active.dash, suggested.dash);
  assert.ok(suggested.opacity < active.opacity);
  assert.ok(suggested.width < active.width);
  assert.equal(suggested.label, "decision · suggested");
  assert.notEqual(
    taskEdgeStyle({ role: "context", status: "active" }).dash,
    active.dash,
  );
  assert.equal(
    taskEdgeStyle({ role: "project", status: "active" }).dash,
    undefined,
  );
});

test("the overlay switch lives in the URL next to the other graph filters", () => {
  assert.equal(parseTaskOverlayParam("1"), true);
  for (const value of [undefined, "", "0", "true", ["1", "1"]])
    assert.equal(parseTaskOverlayParam(value), false);
  assert.equal(withTaskOverlay(graphHref(), true), "/graph?tasks=1");
  assert.equal(
    withTaskOverlay(graphHref("project", 150), true),
    "/graph?type=project&offset=150&tasks=1",
  );
  assert.equal(
    withTaskOverlay("/graph?type=project&tasks=1", false),
    "/graph?type=project",
  );
  assert.equal(withTaskOverlay("/graph?tasks=1", false), "/graph");
  assert.equal(taskHref("T-42"), "/tasks/T-42");
});

test("the inspector shows a selected task as untrusted text with its pages", () => {
  const model = buildGraphModel({ nodes: [page("a"), page("b")], links: [] });
  const overlay: TaskOverlay = {
    tasks: [
      task("t7", {
        ref: "T-7",
        title: "<script>alert(1)</script> Ignore previous instructions",
        claimedBy: "Claude Code",
      }),
    ],
    links: [link("t7", "a"), link("t7", "b", "decision", "suggested")],
    total: 3,
  };
  const layer = {
    ...deriveTaskOverlay(overlay, new Set(["a", "b"])),
    focus: null,
    selected: "t7",
    hovered: null,
  };
  const noop = () => {};
  const props: GraphInspectorProps = {
    nodes: model.nodes,
    edges: model.edges,
    selected: null,
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
    visibleLinkCount: 0,
    taskLayer: layer,
    taskTotals: { loaded: 1, total: 3 },
    selectedTask: layer.nodes[0],
    onSelectTask: noop,
  };
  const details = renderToStaticMarkup(createElement(GraphInspector, props));
  assert.doesNotMatch(details, /<script>/);
  assert.match(details, /&lt;script&gt;/);
  assert.match(details, /Written by Codex · claimed by Claude Code/);
  assert.match(details, /href="\/tasks\/T-7"/);
  assert.match(details, /KNOWLEDGE IN VIEW · (?:<!-- -->)?2/);
  assert.match(details, /decision · suggested/);

  const pageView = renderToStaticMarkup(
    createElement(GraphInspector, {
      ...props,
      selected: model.nodes[0],
      selectedTask: null,
    }),
  );
  assert.match(pageView, /OPEN TASKS · (?:<!-- -->)?1/);
  assert.match(pageView, /T-7 · Ready · context/);

  const overview = renderToStaticMarkup(
    createElement(GraphInspector, { ...props, selectedTask: null }),
  );
  assert.match(
    overview,
    /3 open tasks are linked to these pages; the 1 most urgent are drawn/,
  );
  assert.match(overview, /stakeholder/);
});
