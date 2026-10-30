// The open-task layer of the knowledge graph. Tasks are never pages: they are
// fetched separately, drawn as their own node kind around the pages already in
// view, and never enter the page window, the page layout or its counts.

import {
  OPEN_TASK_STATUSES,
  type TaskLinkRole,
  type TaskStatus,
} from "../tasks/types";
import { hashSeed } from "./layout";
import type { Point } from "./view";

/** Tasks drawn at most; the rest are counted in `total`. */
export const TASK_OVERLAY_LIMIT = 120;
/** Page ids accepted by one overlay request (the graph schema's maximum). */
export const TASK_OVERLAY_MAX_PAGES = 500;
export const TASK_OVERLAY_STATUSES: readonly TaskStatus[] = OPEN_TASK_STATUSES;
/** Half the side of a task square. */
export const TASK_NODE_SIZE = 7;

/** `project` is the task's project page; the others are task→page links. */
export type OverlayLinkRole = TaskLinkRole | "project";
export type OverlayLinkStatus = "active" | "suggested";

export interface OverlayTask {
  id: string;
  ref: string;
  title: string;
  /** Who wrote the title: agent text is reference data, never instructions. */
  authoredBy: string;
  untrusted: boolean;
  status: TaskStatus;
  priority: number;
  claimedBy: string | null;
}

export interface OverlayLink {
  taskId: string;
  pageId: string;
  role: OverlayLinkRole;
  status: OverlayLinkStatus;
}

export interface TaskOverlay {
  tasks: OverlayTask[];
  links: OverlayLink[];
  /** Open tasks anchored to the requested pages, including those over the limit. */
  total: number;
}

export const EMPTY_TASK_OVERLAY: TaskOverlay = {
  tasks: [],
  links: [],
  total: 0,
};

export interface OverlayTaskNode extends OverlayTask {
  /** Visible pages holding the task in place: active links and its project. */
  anchors: string[];
}

export interface OverlayEdge extends OverlayLink {
  id: string;
  /** Ordinal among the task's links to the same page (one per role). */
  lane: number;
}

/**
 * Keeps the tasks anchored by an active link or their project to a page on
 * screen, with every active or suggested link to the pages on screen.
 * Suggested links alone never bring a task into view.
 */
export function deriveTaskOverlay(
  overlay: TaskOverlay,
  visible: ReadonlySet<string>,
): { nodes: OverlayTaskNode[]; edges: OverlayEdge[] } {
  const anchors = new Map<string, Set<string>>();
  for (const link of overlay.links) {
    if (link.status !== "active" || !visible.has(link.pageId)) continue;
    const set = anchors.get(link.taskId) ?? new Set<string>();
    set.add(link.pageId);
    anchors.set(link.taskId, set);
  }
  const nodes: OverlayTaskNode[] = overlay.tasks.flatMap((task) => {
    const pages = anchors.get(task.id);
    return pages ? [{ ...task, anchors: [...pages].sort() }] : [];
  });
  const shown = new Set(nodes.map((node) => node.id));
  const lanes = new Map<string, number>();
  const edges: OverlayEdge[] = [];
  for (const link of overlay.links) {
    if (!shown.has(link.taskId) || !visible.has(link.pageId)) continue;
    const pair = `${link.taskId}|${link.pageId}`;
    const lane = lanes.get(pair) ?? 0;
    lanes.set(pair, lane + 1);
    edges.push({ ...link, id: `${pair}|${link.role}`, lane });
  }
  return { nodes, edges };
}

/**
 * What stays bright while something is selected or hovered. A focused task
 * lights its pages and links; otherwise focused pages light their tasks.
 * Returns null when nothing is focused.
 */
export function overlayEmphasis(
  edges: readonly OverlayEdge[],
  focusTasks: readonly string[],
  focusPages: readonly string[],
): {
  tasks: ReadonlySet<string>;
  pages: ReadonlySet<string>;
  edges: ReadonlySet<string>;
} | null {
  if (!focusTasks.length && !focusPages.length) return null;
  const tasks = new Set(focusTasks);
  const pages = new Set<string>();
  const lit = new Set<string>();
  for (const edge of edges) {
    if (focusTasks.length) {
      if (!tasks.has(edge.taskId)) continue;
      pages.add(edge.pageId);
    } else if (focusPages.includes(edge.pageId)) tasks.add(edge.taskId);
    else continue;
    lit.add(edge.id);
  }
  return { tasks, pages, edges: lit };
}

/** Gap between a page's edge and the tasks orbiting it. */
export const TASK_ORBIT = 26;
const RING_SIZE = 5;
const RING_STEP = 22;
const SHARED_SPREAD = 16;
// Tasks of one page sit on an arc above it, clear of the page label below.
const ARC_START = (200 * Math.PI) / 180;
const ARC_SPAN = (140 * Math.PI) / 180;

/**
 * Places each task next to its anchor pages: on an arc above a single page,
 * or near the centre of several. Pure and deterministic, so the task layer
 * follows the page layout without feeding back into it.
 */
export function placeTaskNodes(
  nodes: readonly OverlayTaskNode[],
  positions: Readonly<Record<string, Point>>,
  radius: (pageId: string) => number,
): Record<string, Point> {
  const groups = new Map<string, OverlayTaskNode[]>();
  for (const node of nodes) {
    const anchors = node.anchors.filter((id) => positions[id]);
    if (!anchors.length) continue;
    const key = anchors.join("|");
    groups.set(key, [...(groups.get(key) ?? []), node]);
  }
  const placed: Record<string, Point> = {};
  for (const [key, members] of groups) {
    const anchors = key.split("|");
    members.sort((a, b) => a.ref.localeCompare(b.ref, "en", { numeric: true }));
    if (anchors.length === 1) {
      const center = positions[anchors[0]];
      const inner = radius(anchors[0]) + TASK_ORBIT;
      members.forEach((member, index) => {
        const ring = Math.floor(index / RING_SIZE);
        const slots = Math.min(RING_SIZE, members.length - ring * RING_SIZE);
        const angle =
          slots === 1
            ? ARC_START + ARC_SPAN / 2
            : ARC_START + (index % RING_SIZE) * (ARC_SPAN / (slots - 1));
        const distance = inner + ring * RING_STEP;
        placed[member.id] = {
          x: center.x + Math.cos(angle) * distance,
          y: center.y + Math.sin(angle) * distance,
        };
      });
      continue;
    }
    const center = {
      x: anchors.reduce((sum, id) => sum + positions[id].x, 0) / anchors.length,
      y: anchors.reduce((sum, id) => sum + positions[id].y, 0) / anchors.length,
    };
    const base = ((hashSeed(key) % 360) * Math.PI) / 180;
    members.forEach((member, index) => {
      const spread =
        members.length === 1 ? 0 : SHARED_SPREAD * Math.sqrt(index + 1);
      const angle = base + index * 2.4;
      placed[member.id] = {
        x: center.x + Math.cos(angle) * spread,
        y: center.y + Math.sin(angle) * spread,
      };
    });
  }
  return placed;
}

export const taskLinkStyles: Record<
  OverlayLinkRole,
  { label: string; dash?: string }
> = {
  project: { label: "in project" },
  produced: { label: "produced" },
  context: { label: "context", dash: "4 3" },
  decision: { label: "decision", dash: "9 3" },
  source: { label: "source", dash: "6 2 1 2" },
  stakeholder: { label: "stakeholder", dash: "1 3" },
};

export function taskEdgeStyle(edge: Pick<OverlayLink, "role" | "status">) {
  const suggested = edge.status === "suggested";
  return {
    dash: taskLinkStyles[edge.role].dash,
    opacity: suggested ? 0.4 : 0.85,
    width: suggested ? 1 : 1.4,
    label: suggested
      ? `${taskLinkStyles[edge.role].label} · suggested`
      : taskLinkStyles[edge.role].label,
  };
}

export const TASK_OVERLAY_PARAM = "tasks";

/** `?tasks=1` turns the overlay on; anything else leaves it off. */
export function parseTaskOverlayParam(
  value: string | string[] | undefined,
): boolean {
  return value === "1";
}

/** Adds or removes the overlay switch on a graph URL, keeping other filters. */
export function withTaskOverlay(href: string, on: boolean): string {
  const [path, query = ""] = href.split("?");
  const params = new URLSearchParams(query);
  if (on) params.set(TASK_OVERLAY_PARAM, "1");
  else params.delete(TASK_OVERLAY_PARAM);
  return params.size ? `${path}?${params}` : path;
}

/** Task links share the task views' canonical URL helper. */
export { taskHref } from "../workspace/task-urls";
