"use client";

import type {
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
  Ref,
} from "react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { typeIcons } from "@/components/workspace/primitives";
import {
  bounds,
  createLayout,
  type Layout,
  type LayoutInputLink,
  reheat,
  settle,
  tick,
} from "@/lib/graph/layout";
import { type GraphEdge, type GraphNode, linkLabel } from "@/lib/graph/model";

export interface GraphCanvasHandle {
  fit(): void;
  zoomBy(factor: number): void;
  focusNode(id: string): void;
  shake(): void;
}

interface View {
  k: number;
  tx: number;
  ty: number;
}
interface Size {
  width: number;
  height: number;
}
interface Point {
  x: number;
  y: number;
}

type Gesture =
  | {
      type: "pan";
      pointerId: number;
      start: Point;
      last: Point;
      moved: boolean;
    }
  | {
      type: "drag";
      pointerId: number;
      nodeId: string;
      start: Point;
      moved: boolean;
    }
  | { type: "pinch"; distance: number; mid: Point };

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 4;
const FIT_MAX_ZOOM = 1.4;
const FIT_PADDING = 56;
const LABEL_LENGTH = 26;
const DOUBLE_CLICK_MS = 350;
const DRAG_THRESHOLD = 4;

function clampZoom(k: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

function zoomAt(view: View, point: Point, factor: number): View {
  const k = clampZoom(view.k * factor);
  const wx = (point.x - view.tx) / view.k;
  const wy = (point.y - view.ty) / view.k;
  return { k, tx: point.x - wx * k, ty: point.y - wy * k };
}

function fitView(
  layout: Layout,
  visible: ReadonlySet<string>,
  size: Size | null,
): View | null {
  if (!size || !size.width || !size.height) return null;
  const shown = layout.nodes.filter((node) => visible.has(node.id));
  const box = bounds(shown.length ? shown : layout.nodes);
  if (!box) return null;
  const width = Math.max(box.maxX - box.minX, 1);
  const height = Math.max(box.maxY - box.minY, 1);
  const k = clampZoom(
    Math.min(
      (size.width - FIT_PADDING * 2) / width,
      (size.height - FIT_PADDING * 2) / height,
      FIT_MAX_ZOOM,
    ),
  );
  return {
    k,
    tx: size.width / 2 - ((box.minX + box.maxX) / 2) * k,
    ty: size.height / 2 - ((box.minY + box.maxY) / 2) * k,
  };
}

function snapshot(layout: Layout) {
  const positions: Record<string, Point> = {};
  for (const node of layout.nodes)
    positions[node.id] = { x: node.x, y: node.y };
  return positions;
}

function towards(from: Point, to: Point, distance: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  return {
    x: from.x + (dx / length) * distance,
    y: from.y + (dy / length) * distance,
  };
}

/** Server and browser math libraries differ in the last digit; rounding keeps markup stable. */
function round(value: number) {
  return Math.round(value * 100) / 100;
}

function truncate(title: string) {
  return title.length > LABEL_LENGTH
    ? `${title.slice(0, LABEL_LENGTH - 1)}…`
    : title;
}

interface GraphCanvasProps {
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

export function GraphCanvas({
  ref,
  nodes,
  layoutLinks,
  edges,
  visible,
  selected,
  hovered,
  emphasized,
  emphasizedEdges,
  matched,
  seed,
  onSelect,
  onHover,
  onOpen,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [initialLayout] = useState(() =>
    createLayout(nodes, layoutLinks, seed),
  );
  const layoutRef = useRef(initialLayout);
  const [positions, setPositions] = useState(() => snapshot(initialLayout));
  const [size, setSize] = useState<Size | null>(null);
  const [view, setView] = useState<View>({ k: 1, tx: 0, ty: 0 });
  const [animated, setAnimated] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const sizeRef = useRef<Size | null>(null);
  const viewRef = useRef(view);
  const visibleRef = useRef(visible);
  const interactedRef = useRef(false);
  const reducedMotionRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const lastClickRef = useRef<{ id: string; time: number } | null>(null);
  const shakeRef = useRef(0);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  useEffect(() => {
    const previous = visibleRef.current;
    visibleRef.current = visible;
    const unchanged =
      previous.size === visible.size &&
      [...visible].every((id) => previous.has(id));
    if (unchanged) return;
    // Filters changed what is on screen: bring the remaining pages into view.
    interactedRef.current = true;
    setAnimated(true);
    const next = fitView(layoutRef.current, visible, sizeRef.current);
    if (next) setView(next);
  }, [visible]);

  const publish = useCallback(() => {
    setPositions(snapshot(layoutRef.current));
  }, []);

  const autoFit = useCallback(() => {
    if (interactedRef.current) return;
    const next = fitView(
      layoutRef.current,
      visibleRef.current,
      sizeRef.current,
    );
    if (next) setView(next);
  }, []);

  const runSimulation = useCallback(() => {
    if (reducedMotionRef.current) {
      settle(layoutRef.current);
      publish();
      autoFit();
      return;
    }
    if (frameRef.current !== null) return;
    const step = () => {
      frameRef.current = null;
      const layout = layoutRef.current;
      const active = tick(layout) && tick(layout);
      publish();
      autoFit();
      if (active) frameRef.current = requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);
  }, [publish, autoFit]);

  useEffect(() => {
    reducedMotionRef.current = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    runSimulation();
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [runSimulation]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const next = {
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      };
      sizeRef.current = next;
      setSize(next);
      autoFit();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [autoFit]);

  useEffect(() => {
    // React registers wheel listeners as passive, which cannot stop page scroll.
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      interactedRef.current = true;
      const rect = svg.getBoundingClientRect();
      const point = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const factor = Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002));
      setAnimated(false);
      setView((current) => zoomAt(current, point, factor));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  const fit = useCallback(() => {
    interactedRef.current = true;
    setAnimated(true);
    const next = fitView(
      layoutRef.current,
      visibleRef.current,
      sizeRef.current,
    );
    if (next) setView(next);
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const current = sizeRef.current;
    if (!current) return;
    interactedRef.current = true;
    setAnimated(true);
    const center = { x: current.width / 2, y: current.height / 2 };
    setView((previous) => zoomAt(previous, center, factor));
  }, []);

  const focusNode = useCallback((id: string) => {
    const current = sizeRef.current;
    const node = layoutRef.current.nodes.find((entry) => entry.id === id);
    if (!current || !node) return;
    interactedRef.current = true;
    setAnimated(true);
    setView((previous) => {
      const k = Math.max(previous.k, 1);
      return {
        k,
        tx: current.width / 2 - node.x * k,
        ty: current.height / 2 - node.y * k,
      };
    });
  }, []);

  const shake = useCallback(() => {
    shakeRef.current += 1;
    layoutRef.current = createLayout(
      nodes,
      layoutLinks,
      seed + shakeRef.current * 7919,
    );
    interactedRef.current = false;
    setAnimated(false);
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    runSimulation();
  }, [nodes, layoutLinks, seed, runSimulation]);

  useImperativeHandle(ref, () => ({ fit, zoomBy, focusNode, shake }), [
    fit,
    zoomBy,
    focusNode,
    shake,
  ]);

  const localPoint = (event: { clientX: number; clientY: number }): Point => {
    const rect = svgRef.current?.getBoundingClientRect();
    return {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    };
  };

  const handleClick = (id: string) => {
    const now = performance.now();
    const last = lastClickRef.current;
    if (last && last.id === id && now - last.time < DOUBLE_CLICK_MS) {
      lastClickRef.current = null;
      onOpen(id);
      return;
    }
    lastClickRef.current = { id, time: now };
    onSelect(id);
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const point = localPoint(event);
    const pointers = pointersRef.current;
    pointers.set(event.pointerId, point);
    svgRef.current?.setPointerCapture(event.pointerId);
    if (pointers.size >= 2) {
      const previous = gestureRef.current;
      if (previous?.type === "drag") {
        // A second finger turns the drag into a pinch; free the page again.
        const node = layoutRef.current.nodes.find(
          (entry) => entry.id === previous.nodeId,
        );
        if (node) {
          node.fx = null;
          node.fy = null;
        }
      }
      const [a, b] = [...pointers.values()];
      gestureRef.current = {
        type: "pinch",
        distance: Math.hypot(b.x - a.x, b.y - a.y) || 1,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
      setDragging(null);
      return;
    }
    const nodeId = (event.target as Element)
      .closest?.("[data-node-id]")
      ?.getAttribute("data-node-id");
    if (nodeId) {
      const node = layoutRef.current.nodes.find((entry) => entry.id === nodeId);
      if (node) {
        node.fx = node.x;
        node.fy = node.y;
      }
      gestureRef.current = {
        type: "drag",
        pointerId: event.pointerId,
        nodeId,
        start: point,
        moved: false,
      };
      setDragging(nodeId);
      return;
    }
    gestureRef.current = {
      type: "pan",
      pointerId: event.pointerId,
      start: point,
      last: point,
      moved: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const pointers = pointersRef.current;
    if (!pointers.has(event.pointerId)) return;
    const point = localPoint(event);
    pointers.set(event.pointerId, point);
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (gesture.type === "pinch") {
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const previous = gesture.mid;
      const ratio = distance / gesture.distance;
      gesture.distance = distance;
      gesture.mid = mid;
      interactedRef.current = true;
      setAnimated(false);
      setView((current) => {
        const k = clampZoom(current.k * ratio);
        const wx = (previous.x - current.tx) / current.k;
        const wy = (previous.y - current.ty) / current.k;
        return { k, tx: mid.x - wx * k, ty: mid.y - wy * k };
      });
      return;
    }
    if (gesture.pointerId !== event.pointerId) return;
    if (
      !gesture.moved &&
      Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) <
        DRAG_THRESHOLD
    )
      return;
    gesture.moved = true;
    interactedRef.current = true;
    if (gesture.type === "pan") {
      const dx = point.x - gesture.last.x;
      const dy = point.y - gesture.last.y;
      gesture.last = point;
      setAnimated(false);
      setView((current) => ({
        ...current,
        tx: current.tx + dx,
        ty: current.ty + dy,
      }));
      return;
    }
    const node = layoutRef.current.nodes.find(
      (entry) => entry.id === gesture.nodeId,
    );
    if (!node) return;
    const { k, tx, ty } = viewRef.current;
    node.x = (point.x - tx) / k;
    node.y = (point.y - ty) / k;
    node.fx = node.x;
    node.fy = node.y;
    if (reducedMotionRef.current) {
      publish();
      return;
    }
    reheat(layoutRef.current, 0.2);
    runSimulation();
  };

  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const pointers = pointersRef.current;
    pointers.delete(event.pointerId);
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (gesture.type === "pinch") {
      if (pointers.size === 1) {
        const [[pointerId, point]] = [...pointers.entries()];
        gestureRef.current = {
          type: "pan",
          pointerId,
          start: point,
          last: point,
          moved: true,
        };
      } else if (pointers.size === 0) gestureRef.current = null;
      return;
    }
    if (gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    const cancelled = event.type === "pointercancel";
    if (gesture.type === "drag") {
      setDragging(null);
      if (gesture.moved) return;
      // A plain click keeps the page free instead of pinning it in place.
      const node = layoutRef.current.nodes.find(
        (entry) => entry.id === gesture.nodeId,
      );
      if (node) {
        node.fx = null;
        node.fy = null;
      }
      if (!cancelled) handleClick(gesture.nodeId);
      return;
    }
    if (!gesture.moved && !cancelled) onSelect(null);
  };

  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === "Escape") {
      onSelect(null);
      return;
    }
    if (event.key === "+" || event.key === "=") zoomBy(1.3);
    else if (event.key === "-" || event.key === "_") zoomBy(1 / 1.3);
    else if (event.key === "0" || event.key.toLowerCase() === "f") fit();
    else return;
    event.preventDefault();
  };

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
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
  const hoveredNode = hovered ? nodeById.get(hovered) : undefined;
  const hoveredPosition = hovered ? positions[hovered] : undefined;
  const transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.k})`;

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full touch-none select-none overflow-hidden bg-card"
    >
      <svg
        ref={svgRef}
        role="application"
        aria-label="Knowledge graph. Pages are buttons; press Enter to inspect one, Escape to clear, plus and minus to zoom, F to fit."
        className={`block h-full w-full transition-opacity duration-300 ${size ? "opacity-100" : "opacity-0"}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <title>Knowledge graph canvas</title>
        <defs>
          <pattern
            id="graph-dots"
            width="28"
            height="28"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="1.5" cy="1.5" r="1" className="fill-border" />
          </pattern>
          <marker
            id="graph-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path
              d="M0 1 L8 5 L0 9 Z"
              className="fill-muted-foreground"
              fillOpacity={0.55}
            />
          </marker>
          <marker
            id="graph-arrow-active"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path d="M0 1 L8 5 L0 9 Z" className="fill-primary" />
          </marker>
        </defs>
        <g
          style={{
            transform,
            transformOrigin: "0 0",
            transition: animated ? "transform 350ms ease" : "none",
          }}
        >
          <rect
            x={-6000}
            y={-6000}
            width={12000}
            height={12000}
            fill="url(#graph-dots)"
          />
          <g>
            {size &&
              edges.map((edge) => {
                const source = positions[edge.sourceId];
                const target = positions[edge.targetId];
                const sourceNode = nodeById.get(edge.sourceId);
                const targetNode = nodeById.get(edge.targetId);
                if (!source || !target || !sourceNode || !targetNode)
                  return null;
                const active = emphasizedEdges.has(edge.id);
                const faded =
                  !active &&
                  (emphasized !== null ||
                    (matched !== null &&
                      !(
                        matched.has(edge.sourceId) && matched.has(edge.targetId)
                      )));
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
                      className={
                        active ? "stroke-primary" : "stroke-muted-foreground"
                      }
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
          <g>
            {size &&
              nodes.map((node) => {
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
                    <circle
                      r={radius + 9}
                      className="fill-card"
                      fillOpacity={0}
                    />
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
        </g>
      </svg>
      {hoveredNode && hoveredPosition && !dragging && hovered !== selected && (
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
      )}
    </div>
  );
}
