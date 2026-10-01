"use client";
import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Point } from "@/lib/graph/view";
import type { GraphCanvasProps } from "./canvas-types";
import type { useGraphSimulation } from "./use-graph-simulation";

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

const DOUBLE_CLICK_MS = 350;
const DRAG_THRESHOLD = 4;
export function useGraphGestures(
  simulation: ReturnType<typeof useGraphSimulation>,
  { onSelect, onOpen }: Pick<GraphCanvasProps, "onSelect" | "onOpen">,
) {
  const { pin, unpin, dragTo, zoom, pan, pinch, fit, zoomBy } = simulation;
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const lastClickRef = useRef<{ id: string; time: number } | null>(null);
  useEffect(() => {
    // React registers wheel listeners as passive, which cannot stop page scroll.
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const point = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const factor = Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002));
      zoom(point, factor);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [zoom]);

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
        unpin(previous.nodeId);
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
      pin(nodeId);
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
      pinch(previous, mid, ratio);
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
    if (gesture.type === "pan") {
      const dx = point.x - gesture.last.x;
      const dy = point.y - gesture.last.y;
      gesture.last = point;
      pan(dx, dy);
      return;
    }
    dragTo(gesture.nodeId, point);
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
      unpin(gesture.nodeId);
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

  return {
    svgRef,
    dragging,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onKeyDown,
  };
}
