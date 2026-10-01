"use client";
import { useImperativeHandle } from "react";
import type { GraphCanvasProps } from "./canvas-types";

export type { GraphCanvasHandle } from "./canvas-types";

import { GraphEdges } from "./graph-edges";
import { GraphNodes } from "./graph-nodes";
import { GraphTooltip } from "./graph-tooltip";
import { useGraphGestures } from "./use-graph-gestures";
import { useGraphSimulation } from "./use-graph-simulation";
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
  const simulation = useGraphSimulation(nodes, layoutLinks, seed, visible);
  const {
    containerRef,
    positions,
    size,
    view,
    animated,
    fit,
    zoomBy,
    focusNode,
    shake,
  } = simulation;
  const {
    svgRef,
    dragging,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onKeyDown,
  } = useGraphGestures(simulation, { onSelect, onOpen });
  useImperativeHandle(ref, () => ({ fit, zoomBy, focusNode, shake }), [
    fit,
    zoomBy,
    focusNode,
    shake,
  ]);
  const hoveredNode = nodes.find((node) => node.id === hovered);
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
          {size && (
            <>
              <GraphEdges
                edges={edges}
                nodes={nodes}
                positions={positions}
                emphasized={emphasized}
                emphasizedEdges={emphasizedEdges}
                matched={matched}
              />
              <GraphNodes
                nodes={nodes}
                positions={positions}
                visible={visible}
                selected={selected}
                hovered={hovered}
                emphasized={emphasized}
                matched={matched}
                view={view}
                dragging={dragging}
                onHover={onHover}
                onSelect={onSelect}
              />
            </>
          )}
        </g>
      </svg>
      {hoveredNode && hoveredPosition && !dragging && hovered !== selected && (
        <GraphTooltip
          node={hoveredNode}
          position={hoveredPosition}
          view={view}
        />
      )}
    </div>
  );
}
