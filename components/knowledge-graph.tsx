"use client";

import { ArrowUpRight, Network, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { pageHref } from "@/lib/workspace/urls";
import { type BrainLink, entityTypes, type PageSummary } from "./brain-types";
import { Empty } from "./workspace/primitives";

export function KnowledgeGraph({
  graph,
}: {
  graph: { nodes: PageSummary[]; links: BrainLink[] };
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 740px)");
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const nodes = useMemo(() => {
    const filtered =
      graph?.nodes.filter((n) => !filter || n.type === filter) ?? [];
    return filtered.map((node, index) => {
      const angle =
        (index / Math.max(filtered.length, 1)) * Math.PI * 2 - Math.PI / 2;
      const radius =
        filtered.length === 1
          ? 0
          : filtered.length <= 8
            ? compact
              ? 130
              : 180
            : index % 2 === 0
              ? compact
                ? 150
                : 225
              : compact
                ? 85
                : 130;
      return {
        ...node,
        x:
          (compact ? 230 : 460) +
          Math.cos(angle) * radius * (compact ? 1 : 1.42),
        y: (compact ? 260 : 315) + Math.sin(angle) * radius,
      };
    });
  }, [graph, filter, compact]);
  const selectedPage = nodes.find((node) => node.id === selected);
  const selectedLinks =
    graph?.links.filter(
      (link) => link.sourceId === selected || link.targetId === selected,
    ) ?? [];
  const neighbors = new Set(
    selectedLinks.flatMap((link) => [link.sourceId, link.targetId]),
  );
  return (
    <>
      {!graph.nodes.length ? (
        <Empty
          icon={<Network size={32} strokeWidth={1.2} />}
          title="Knowledge grows between the dots."
          description="Create a few pages and connect them with typed links. Their relationships will take shape here."
        />
      ) : (
        <>
          <Button
            type="button"
            variant="outline"
            className="mb-4"
            onClick={() => {
              setSelected(null);
              setFilter("");
            }}
          >
            <RotateCcw size={15} />
            Reset view
          </Button>
          <div className="graph-toolbar flex items-center justify-between gap-[15px] mb-[19px] max-[740px]:items-start max-[460px]:flex-col max-[460px]:gap-[5px]">
            <div className="graph-legend flex flex-wrap gap-[7px] max-[460px]:gap-[1px]">
              {entityTypes.map((type) => (
                <Button
                  type="button"
                  variant="ghost"
                  key={type.id}
                  className={filter === type.id ? "active" : ""}
                  onClick={() => {
                    setFilter(filter === type.id ? "" : type.id);
                    setSelected(null);
                  }}
                >
                  <span
                    className={`legend-dot h-[7px] w-[7px] block rounded-full [background:currentColor] entity-${type.id}`}
                  />
                  {type.label}
                </Button>
              ))}
            </div>
            <span>
              {nodes.length} pages · {graph.links.length} links
            </span>
          </div>
          <div className="graph-canvas relative [border:1px_solid_var(--line)] rounded-[7px] overflow-hidden [background:#f7f9f0]">
            <svg
              viewBox={compact ? "0 0 460 560" : "0 0 920 630"}
              role="img"
              aria-label="Interactive knowledge graph. Select a page to inspect its connections."
            >
              <title>Your knowledge graph</title>
              <defs>
                <pattern
                  id="graph-dots"
                  width="24"
                  height="24"
                  patternUnits="userSpaceOnUse"
                >
                  <circle cx="2" cy="2" r=".7" fill="#c9cabc" />
                </pattern>
              </defs>
              <rect width="920" height="630" fill="url(#graph-dots)" />
              {graph.links.map((link) => {
                const source = nodes.find((node) => node.id === link.sourceId);
                const target = nodes.find((node) => node.id === link.targetId);
                if (!source || !target) return null;
                const active =
                  !selected ||
                  link.sourceId === selected ||
                  link.targetId === selected;
                return (
                  <g key={link.id} opacity={active ? 1 : 0.12}>
                    <line
                      x1={source.x}
                      y1={source.y}
                      x2={target.x}
                      y2={target.y}
                      stroke={selected ? "#546849" : "#c2c8b8"}
                      strokeWidth={selected && active ? 1.8 : 1}
                    />
                    {selected && active && (
                      <text
                        x={(source.x + target.x) / 2}
                        y={(source.y + target.y) / 2 - 6}
                        textAnchor="middle"
                        className="graph-edge-label [fill:#8b9b79] [font-size:8px] [font-family:var(--sans)] [paint-order:stroke] [stroke:#f7f9f0] [stroke-width:5px] [stroke-linejoin:round]"
                      >
                        {link.type.replaceAll("_", " ")}
                      </text>
                    )}
                  </g>
                );
              })}
              {nodes.map((node) => (
                // biome-ignore lint/a11y/useSemanticElements: SVG nodes need an SVG group; equivalent buttons are available in the page list.
                <g
                  key={node.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Inspect ${node.title}, ${node.type}`}
                  className={`graph-node cursor-pointer graph-node-${node.type} ${selected === node.id ? "selected" : ""}`}
                  opacity={
                    !selected || neighbors.has(node.id) || selected === node.id
                      ? 1
                      : 0.3
                  }
                  onClick={() =>
                    setSelected(selected === node.id ? null : node.id)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelected(selected === node.id ? null : node.id);
                    }
                  }}
                >
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={selected === node.id ? 15 : 9}
                  />
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r="25"
                    fill="transparent"
                    stroke="none"
                  />
                  <text x={node.x} y={node.y + 33} textAnchor="middle">
                    {node.title.length > (compact ? 19 : 27)
                      ? `${node.title.slice(0, compact ? 17 : 25)}…`
                      : node.title}
                  </text>
                </g>
              ))}
            </svg>
            <div className="graph-caption absolute bottom-[20px] left-[22px] flex items-center gap-2 [color:#a0ae91] [font-size:9px] max-[460px]:[font-size:7px] max-[460px]:bottom-[12px] max-[460px]:left-[13px]">
              <Network size={14} className="shrink-0" /> Select a page to
              explore its neighborhood.
            </div>
          </div>
          {selectedPage && (
            <div className="graph-inspector flex items-center justify-between gap-6 p-[23px] [border:1px_solid_#d4e1c3] rounded-[6px] [background:#f0f5e7] mt-[17px] max-[460px]:p-[18px] max-[460px]:gap-[13px]">
              <div>
                <span className="eyebrow [font-size:10px] font-semibold tracking-[.16em] text-primary">
                  {selectedPage.type}
                </span>
                <h2>{selectedPage.title}</h2>
                <p>
                  {selectedPage.summary ||
                    `${selectedLinks.length} connections`}
                </p>
              </div>
              <Link
                href={pageHref(selectedPage.id)}
                className="button bg-transparent [border:1px_solid_#d8dbcf] rounded-[6px] p-[10px_15px] inline-flex items-center justify-center gap-2 leading-[1.3] font-medium [font-size:12px] min-h-[39px] [transition:background_.15s,_border-color_.15s,_transform_.15s] whitespace-nowrap primary"
              >
                Read page <ArrowUpRight size={15} />
              </Link>
            </div>
          )}
          <details className="graph-accessible mt-5 [color:#96a885] [font-size:10px]">
            <summary>Browse pages as a list</summary>
            <div>
              {nodes.map((node) => (
                <Link
                  href={pageHref(node.id)}
                  className="text-link h-auto justify-start inline-flex items-center gap-[7px] p-[0] text-primary bg-transparent [font-size:12px] font-semibold text-left"
                  key={node.id}
                >
                  {node.title}
                  <ArrowUpRight size={13} />
                </Link>
              ))}
            </div>
          </details>
        </>
      )}
    </>
  );
}
