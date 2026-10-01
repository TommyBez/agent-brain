"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createLayout,
  type Layout,
  type LayoutInputLink,
  reheat,
  settle,
  tick,
} from "@/lib/graph/layout";
import type { GraphNode } from "@/lib/graph/model";
import {
  clampZoom,
  fitView,
  type Point,
  type Size,
  type View,
  zoomAt,
} from "@/lib/graph/view";

function snapshot(layout: Layout) {
  const positions: Record<string, Point> = {};
  for (const node of layout.nodes)
    positions[node.id] = { x: node.x, y: node.y };
  return positions;
}

export function useGraphSimulation(
  nodes: GraphNode[],
  layoutLinks: LayoutInputLink[],
  seed: number,
  visible: ReadonlySet<string>,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [initialLayout] = useState(() =>
    createLayout(nodes, layoutLinks, seed),
  );
  const layoutRef = useRef(initialLayout);
  const [positions, setPositions] = useState(() => snapshot(initialLayout));
  const [size, setSize] = useState<Size | null>(null);
  const [view, setView] = useState<View>({ k: 1, tx: 0, ty: 0 });
  const [animated, setAnimated] = useState(false);
  const sizeRef = useRef<Size | null>(null);
  const viewRef = useRef(view);
  const visibleRef = useRef(visible);
  const interactedRef = useRef(false);
  const reducedMotionRef = useRef(false);
  const frameRef = useRef<number | null>(null);
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

  const pin = useCallback((id: string) => {
    const node = layoutRef.current.nodes.find((node) => node.id === id);
    if (node) {
      node.fx = node.x;
      node.fy = node.y;
    }
  }, []);
  const unpin = useCallback((id: string) => {
    const node = layoutRef.current.nodes.find((node) => node.id === id);
    if (node) {
      node.fx = null;
      node.fy = null;
    }
  }, []);
  const dragTo = useCallback(
    (id: string, point: Point) => {
      const node = layoutRef.current.nodes.find((node) => node.id === id);
      if (!node) return;
      interactedRef.current = true;
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
    },
    [publish, runSimulation],
  );
  const zoom = useCallback((point: Point, factor: number) => {
    interactedRef.current = true;
    setAnimated(false);
    setView((view) => zoomAt(view, point, factor));
  }, []);
  const pan = useCallback((dx: number, dy: number) => {
    interactedRef.current = true;
    setAnimated(false);
    setView((view) => ({ ...view, tx: view.tx + dx, ty: view.ty + dy }));
  }, []);
  const pinch = useCallback((previous: Point, mid: Point, ratio: number) => {
    interactedRef.current = true;
    setAnimated(false);
    setView((view) => {
      const k = clampZoom(view.k * ratio);
      return {
        k,
        tx: mid.x - ((previous.x - view.tx) / view.k) * k,
        ty: mid.y - ((previous.y - view.ty) / view.k) * k,
      };
    });
  }, []);
  return {
    containerRef,
    positions,
    size,
    view,
    animated,
    pin,
    unpin,
    dragTo,
    zoom,
    pan,
    pinch,
    fit,
    zoomBy,
    focusNode,
    shake,
  };
}
