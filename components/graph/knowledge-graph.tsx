"use client";

import {
  Maximize2,
  Network,
  Search,
  Shuffle,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { entityTypes } from "@/lib/brain/labels";
import type {
  BrainLink,
  LinkType,
  PageSummary,
  PageType,
} from "@/lib/brain/types";
import { deriveGraphView } from "@/lib/graph/derive-view";
import { buildGraphModel } from "@/lib/graph/model";
import { pageHref } from "@/lib/workspace/urls";
import { Empty } from "../workspace/primitives";
import { GraphCanvas, type GraphCanvasHandle } from "./graph-canvas";
import { GraphInspector } from "./graph-inspector";

const TRAIL_LIMIT = 20;

function toggled<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function KnowledgeGraph({
  graph,
  initialSelected,
}: {
  graph: { nodes: PageSummary[]; links: BrainLink[] };
  initialSelected?: string;
}) {
  const router = useRouter();
  const canvas = useRef<GraphCanvasHandle>(null);
  const [trail, setTrail] = useState<string[]>(() =>
    initialSelected && graph.nodes.some((node) => node.id === initialSelected)
      ? [initialSelected]
      : [],
  );
  const [hovered, setHovered] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hiddenTypes, setHiddenTypes] = useState<ReadonlySet<PageType>>(
    () => new Set(),
  );
  const [hiddenLinkTypes, setHiddenLinkTypes] = useState<ReadonlySet<LinkType>>(
    () => new Set(),
  );
  const [showUnlinked, setShowUnlinked] = useState(true);

  const model = useMemo(() => buildGraphModel(graph), [graph]);
  const {
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
  } = useMemo(
    () =>
      deriveGraphView(
        model,
        { hiddenTypes, hiddenLinkTypes, showUnlinked, query },
        { trail, hovered },
      ),
    [model, hiddenTypes, hiddenLinkTypes, showUnlinked, query, trail, hovered],
  );

  if (!graph.nodes.length) {
    return (
      <Empty
        icon={<Network className="size-8" />}
        title="No pages to explore"
        description="Create pages and add connections to see their relationships here."
      />
    );
  }

  const select = (id: string | null, center = false) => {
    if (!id) {
      setTrail([]);
      return;
    }
    setTrail((current) =>
      current[current.length - 1] === id
        ? current
        : [...current.filter((entry) => entry !== id), id].slice(-TRAIL_LIMIT),
    );
    if (center) canvas.current?.focusNode(id);
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start">
      <div className="relative min-w-0 h-[clamp(420px,62vh,760px)] overflow-hidden rounded-xl border bg-card">
        <GraphCanvas
          ref={canvas}
          nodes={model.nodes}
          layoutLinks={model.edges}
          edges={edges}
          visible={visible}
          selected={selected?.id ?? null}
          hovered={hoveredId}
          emphasized={emphasized}
          emphasizedEdges={emphasizedEdges}
          matched={matched}
          seed={seed}
          onSelect={(id) => select(id)}
          onHover={setHovered}
          onOpen={(id) => router.push(pageHref(id))}
        />
        <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between gap-2">
          <div className="pointer-events-auto w-full max-w-64">
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && matches?.length) {
                    event.preventDefault();
                    select(matches[0].id, true);
                  } else if (event.key === "Escape" && query) {
                    event.preventDefault();
                    setQuery("");
                  }
                }}
                placeholder="Find in graph…"
                aria-label="Find pages in the graph"
                autoComplete="off"
                className="bg-background pr-8 pl-8 shadow-xs"
              />
              {query && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Clear search"
                  className="absolute top-1/2 right-1.5 -translate-y-1/2"
                  onClick={() => setQuery("")}
                >
                  <X />
                </Button>
              )}
            </div>
            {matches && (
              <p className="mt-1.5 rounded-md bg-background/80 px-1 text-xs text-muted-foreground">
                {matches.length === 0
                  ? "No pages match."
                  : `${matches.length} ${matches.length === 1 ? "match" : "matches"} · Enter selects the first`}
              </p>
            )}
          </div>
          <div
            role="toolbar"
            aria-label="Graph view controls"
            className="pointer-events-auto flex flex-col gap-0.5 rounded-md border bg-background p-1 shadow-xs"
          >
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom in"
              onClick={() => canvas.current?.zoomBy(1.3)}
            >
              <ZoomIn />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom out"
              onClick={() => canvas.current?.zoomBy(1 / 1.3)}
            >
              <ZoomOut />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Fit graph to view"
              onClick={() => canvas.current?.fit()}
            >
              <Maximize2 />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Shuffle layout"
              onClick={() => canvas.current?.shake()}
            >
              <Shuffle />
            </Button>
          </div>
        </div>
        <div className="pointer-events-none absolute inset-x-3 bottom-3 flex flex-wrap items-end justify-between gap-2 text-xs text-muted-foreground">
          <ul className="flex flex-wrap gap-x-3 gap-y-1 lg:hidden">
            {typeCounts.map((item) => (
              <li
                key={item.type}
                className={`entity-${item.type} inline-flex items-center gap-1.5`}
              >
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full bg-secondary-foreground"
                />
                {entityTypes.find((entry) => entry.id === item.type)?.label}{" "}
                {item.count}
              </li>
            ))}
          </ul>
          <p className="hidden sm:block">
            Scroll to zoom · drag to pan · double-click opens a page
          </p>
        </div>
        <output aria-live="polite" className="sr-only">
          {selected
            ? `${selected.title} selected, ${selected.degree} ${selected.degree === 1 ? "connection" : "connections"}.`
            : ""}
        </output>
      </div>
      <aside
        aria-label="Graph inspector"
        className="min-w-0 rounded-xl border bg-card lg:h-[clamp(420px,62vh,760px)] lg:overflow-y-auto"
      >
        <GraphInspector
          nodes={inspectorNodes}
          edges={inspectorEdges}
          selected={selected}
          canGoBack={trail.length > 1}
          onSelect={(id) => select(id, true)}
          onBack={() => setTrail((current) => current.slice(0, -1))}
          onClear={() => setTrail([])}
          typeCounts={typeCounts}
          hiddenTypes={hiddenTypes}
          onToggleType={(type) =>
            setHiddenTypes((current) => toggled(current, type))
          }
          linkTypeCounts={linkTypeCounts}
          hiddenLinkTypes={hiddenLinkTypes}
          onToggleLinkType={(type) =>
            setHiddenLinkTypes((current) => toggled(current, type))
          }
          unlinkedCount={unlinkedCount}
          unlinkedVisibleCount={unlinkedVisibleCount}
          showUnlinked={showUnlinked}
          onToggleUnlinked={() => setShowUnlinked((current) => !current)}
          visibleCount={visible.size}
          visibleLinkCount={edges.length}
        />
      </aside>
    </div>
  );
}
