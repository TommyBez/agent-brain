"use client";

import { ArrowUpRight, Network, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { pageHref } from "@/lib/workspace/urls";
import type { BrainLink, PageSummary } from "./brain-types";
import { Empty } from "./workspace/primitives";

export function KnowledgeGraph({
  graph,
}: {
  graph: { nodes: PageSummary[]; links: BrainLink[] };
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 740px)");
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const nodes = useMemo(() => {
    const filtered = graph.nodes;
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
  }, [graph, compact]);
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
          icon={<Network className="size-8" />}
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
            }}
          >
            <RotateCcw />
            Clear selection
          </Button>
          <div className="relative overflow-hidden rounded-lg border bg-card">
            <svg
              viewBox={compact ? "0 0 460 560" : "0 0 920 630"}
              className="block h-auto max-h-160 w-full"
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
                  <circle cx="2" cy="2" r=".7" className="fill-border" />
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
                      className={selected ? "stroke-primary" : "stroke-border"}
                      strokeWidth={selected && active ? 1.8 : 1}
                    />
                    {selected && active && (
                      <text
                        x={(source.x + target.x) / 2}
                        y={(source.y + target.y) / 2 - 6}
                        textAnchor="middle"
                        className="fill-muted-foreground stroke-card font-sans text-xs"
                        paintOrder="stroke"
                        strokeWidth={5}
                        strokeLinejoin="round"
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
                  className={`cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring entity-${node.type}`}
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
                    className={`fill-secondary-foreground ${selected === node.id ? "stroke-primary" : "stroke-card"}`}
                    strokeWidth={selected === node.id ? 2 : 3}
                  />
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r="25"
                    className="fill-card"
                    fillOpacity={0}
                    stroke="none"
                  />
                  <text
                    x={node.x}
                    y={node.y + 33}
                    textAnchor="middle"
                    className={`fill-foreground stroke-card font-sans font-medium ${compact ? "text-base" : "text-xs"}`}
                    paintOrder="stroke"
                    strokeWidth={5}
                    strokeLinejoin="round"
                  >
                    {node.title.length > (compact ? 19 : 27)
                      ? `${node.title.slice(0, compact ? 17 : 25)}…`
                      : node.title}
                  </text>
                </g>
              ))}
            </svg>
            <div className="absolute inset-x-4 bottom-4 flex items-center gap-2 text-xs text-muted-foreground">
              <Network className="size-4 shrink-0" /> Select a page to explore
              its neighborhood.
            </div>
          </div>
          {selectedPage && (
            <Card className="mt-4">
              <CardHeader>
                <Badge
                  variant="secondary"
                  className={`capitalize type-${selectedPage.type}`}
                >
                  {selectedPage.type}
                </Badge>
                <CardTitle className="break-words">
                  {selectedPage.title}
                </CardTitle>
                <CardDescription className="break-words">
                  {selectedPage.summary ||
                    `${selectedLinks.length} connections`}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild>
                  <Link href={pageHref(selectedPage.id)}>
                    Read page <ArrowUpRight />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          )}
          <details className="mt-5 text-sm text-muted-foreground">
            <summary className="cursor-pointer">Browse pages as a list</summary>
            <div className="mt-4 flex flex-wrap gap-2">
              {nodes.map((node) => (
                <Button
                  key={node.id}
                  variant="link"
                  asChild
                  className="max-w-full"
                >
                  <Link href={pageHref(node.id)} title={node.title}>
                    <span className="truncate">{node.title}</span>
                    <ArrowUpRight />
                  </Link>
                </Button>
              ))}
            </div>
          </details>
        </>
      )}
    </>
  );
}
