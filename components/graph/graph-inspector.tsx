"use client";

import { ArrowLeft, ArrowUpRight, Pencil, X } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import type { LinkType, PageType } from "@/lib/brain/types";
import { type GraphEdge, type GraphNode, linkLabel } from "@/lib/graph/model";
import { pageHref } from "@/lib/workspace/urls";
import { entityTypes, formatDate } from "../brain-types";
import { EntityIcon } from "../workspace/primitives";

export interface GraphInspectorProps {
  nodes: GraphNode[];
  /** Every loaded link, so a hidden relationship type still counts as a connection. */
  edges: GraphEdge[];
  selected: GraphNode | null;
  canGoBack: boolean;
  onSelect: (id: string) => void;
  onBack: () => void;
  onClear: () => void;
  typeCounts: { type: PageType; count: number }[];
  hiddenTypes: ReadonlySet<PageType>;
  onToggleType: (type: PageType) => void;
  linkTypeCounts: { type: LinkType; count: number }[];
  hiddenLinkTypes: ReadonlySet<LinkType>;
  onToggleLinkType: (type: LinkType) => void;
  /** Unlinked pages in the loaded graph, shown next to the toggle. */
  unlinkedCount: number;
  /** Unlinked pages currently drawn. */
  unlinkedVisibleCount: number;
  showUnlinked: boolean;
  onToggleUnlinked: () => void;
  visibleCount: number;
  visibleLinkCount: number;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-medium tracking-widest text-muted-foreground">
      {children}
    </h3>
  );
}

function typeLabel(type: PageType) {
  return entityTypes.find((item) => item.id === type)?.label ?? type;
}

function NodeButton({
  node,
  caption,
  onSelect,
}: {
  node: GraphNode;
  caption: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onSelect(node.id)}
        className={`entity-${node.type} flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none`}
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
          <EntityIcon type={node.type} size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-foreground">{node.title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {caption}
          </span>
        </span>
      </button>
      <Button variant="ghost" size="icon-sm" asChild>
        <Link href={pageHref(node.id)} aria-label={`Open ${node.title}`}>
          <ArrowUpRight />
        </Link>
      </Button>
    </div>
  );
}

function Details({
  selected,
  nodes,
  edges,
  canGoBack,
  onSelect,
  onBack,
  onClear,
}: Pick<
  GraphInspectorProps,
  | "selected"
  | "nodes"
  | "edges"
  | "canGoBack"
  | "onSelect"
  | "onBack"
  | "onClear"
> & { selected: GraphNode }) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = edges.flatMap((edge) => {
    if (!edge.directed || edge.sourceId !== selected.id) return [];
    const node = nodeById.get(edge.targetId);
    return node ? [{ edge, node }] : [];
  });
  const incoming = edges.flatMap((edge) => {
    if (!edge.directed || edge.targetId !== selected.id) return [];
    const node = nodeById.get(edge.sourceId);
    return node ? [{ edge, node }] : [];
  });
  // relates_to and collaborates_with have no direction; show them symmetrically.
  const linked = edges.flatMap((edge) => {
    if (edge.directed) return [];
    const otherId =
      edge.sourceId === selected.id
        ? edge.targetId
        : edge.targetId === selected.id
          ? edge.sourceId
          : null;
    if (!otherId) return [];
    const node = nodeById.get(otherId);
    return node ? [{ edge, node }] : [];
  });
  const total = outgoing.length + incoming.length + linked.length;
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-2">
        <Badge
          variant="secondary"
          className={`capitalize type-${selected.type}`}
        >
          <EntityIcon type={selected.type} size={13} /> {selected.type}
        </Badge>
        <div className="flex gap-1">
          {canGoBack && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Back to previous page"
              onClick={onBack}
            >
              <ArrowLeft />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear selection"
            onClick={onClear}
          >
            <X />
          </Button>
        </div>
      </div>
      <div className="space-y-2">
        <h2 className="wrap-anywhere font-serif text-2xl leading-tight">
          {selected.title}
        </h2>
        {selected.summary ? (
          <p className="wrap-anywhere text-sm leading-relaxed text-muted-foreground">
            {selected.summary}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No summary yet.</p>
        )}
        <p className="text-xs text-muted-foreground">
          Updated {formatDate(selected.updatedAt)} · version {selected.version}
        </p>
        {selected.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {selected.tags.map((tag) => (
              <Badge
                key={tag}
                variant="outline"
                className="max-w-full whitespace-normal wrap-anywhere"
              >
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link href={pageHref(selected.id)}>
            Read page <ArrowUpRight />
          </Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href={`${pageHref(selected.id)}/edit`}>
            <Pencil /> Edit
          </Link>
        </Button>
      </div>
      <Separator />
      <div className="space-y-3">
        <SectionTitle>CONNECTIONS · {total}</SectionTitle>
        {total === 0 && (
          <p className="text-sm text-muted-foreground">
            No links to other loaded pages. Open the page to see every
            connection, or edit it to add one.
          </p>
        )}
        {outgoing.length > 0 && (
          <div className="space-y-1">
            <p className="px-2 text-xs text-muted-foreground">
              Outgoing · {outgoing.length}
            </p>
            {outgoing.map(({ edge, node }) => (
              <NodeButton
                key={edge.id}
                node={node}
                caption={`${linkLabel(edge.type)} →`}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
        {incoming.length > 0 && (
          <div className="space-y-1">
            <p className="px-2 text-xs text-muted-foreground">
              Incoming · {incoming.length}
            </p>
            {incoming.map(({ edge, node }) => (
              <NodeButton
                key={edge.id}
                node={node}
                caption={`← ${linkLabel(edge.type)}`}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
        {linked.length > 0 && (
          <div className="space-y-1">
            <p className="px-2 text-xs text-muted-foreground">
              Linked · {linked.length}
            </p>
            {linked.map(({ edge, node }) => (
              <NodeButton
                key={edge.id}
                node={node}
                caption={`↔ ${linkLabel(edge.type)}`}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
        {total > 0 && (
          <p className="px-2 text-xs text-muted-foreground">
            Select a connection to walk the graph. Only links between loaded
            pages appear here.
          </p>
        )}
      </div>
    </div>
  );
}

function Overview({
  nodes,
  typeCounts,
  hiddenTypes,
  onToggleType,
  linkTypeCounts,
  hiddenLinkTypes,
  onToggleLinkType,
  unlinkedCount,
  unlinkedVisibleCount,
  showUnlinked,
  onToggleUnlinked,
  visibleCount,
  visibleLinkCount,
  onSelect,
}: Omit<GraphInspectorProps, "selected" | "canGoBack" | "onBack" | "onClear">) {
  const hubs = nodes
    .filter((node) => node.hub)
    .sort((a, b) => b.degree - a.degree || a.title.localeCompare(b.title));
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h2 className="font-serif text-xl">In view</h2>
        <dl className="grid grid-cols-3 gap-3">
          {[
            { label: "Pages", value: visibleCount },
            { label: "Links", value: visibleLinkCount },
            { label: "Unlinked", value: unlinkedVisibleCount },
          ].map((item) => (
            <div key={item.label} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{item.label}</dt>
              <dd className="font-serif text-2xl">{item.value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">
          Select a page in the graph to inspect it. Hover to preview, drag to
          rearrange, double-click to open.
        </p>
      </div>
      <Separator />
      <div className="space-y-2">
        <SectionTitle>PAGE TYPES</SectionTitle>
        {typeCounts.map((item) => {
          const id = `graph-type-${item.type}`;
          return (
            <div
              key={item.type}
              className={`entity-${item.type} flex items-center gap-2.5`}
            >
              <Checkbox
                id={id}
                checked={!hiddenTypes.has(item.type)}
                onCheckedChange={() => onToggleType(item.type)}
              />
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-full bg-secondary-foreground"
              />
              <Label htmlFor={id} className="flex-1 cursor-pointer font-normal">
                {typeLabel(item.type)}
              </Label>
              <span className="text-xs text-muted-foreground">
                {item.count}
              </span>
            </div>
          );
        })}
        {unlinkedCount > 0 && (
          <div className="flex items-center gap-2.5 border-t pt-2">
            <Checkbox
              id="graph-unlinked"
              checked={showUnlinked}
              onCheckedChange={onToggleUnlinked}
            />
            <Label
              htmlFor="graph-unlinked"
              className="flex-1 cursor-pointer font-normal"
            >
              Show unlinked pages
            </Label>
            <span className="text-xs text-muted-foreground">
              {unlinkedCount}
            </span>
          </div>
        )}
      </div>
      {linkTypeCounts.length > 0 && (
        <>
          <Separator />
          <div className="space-y-2">
            <SectionTitle>RELATIONSHIPS</SectionTitle>
            {linkTypeCounts.map((item) => {
              const id = `graph-link-${item.type}`;
              return (
                <div key={item.type} className="flex items-center gap-2.5">
                  <Checkbox
                    id={id}
                    checked={!hiddenLinkTypes.has(item.type)}
                    onCheckedChange={() => onToggleLinkType(item.type)}
                  />
                  <Label
                    htmlFor={id}
                    className="flex-1 cursor-pointer font-normal"
                  >
                    {linkLabel(item.type)}
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    {item.count}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
      {hubs.length > 0 && (
        <>
          <Separator />
          <div className="space-y-2">
            <SectionTitle>MOST CONNECTED</SectionTitle>
            <div className="space-y-0.5">
              {hubs.map((node) => (
                <NodeButton
                  key={node.id}
                  node={node}
                  caption={`${node.degree} ${node.degree === 1 ? "link" : "links"} · ${node.type}`}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>
        </>
      )}
      <Separator />
      <div className="space-y-1.5 text-xs text-muted-foreground">
        <SectionTitle>SHORTCUTS</SectionTitle>
        <p>Scroll or pinch to zoom · drag the canvas to pan</p>
        <p>Drag a page to pin it · shuffle resets pins</p>
        <p>Esc clears · + and − zoom · F fits everything</p>
      </div>
    </div>
  );
}

export function GraphInspector(props: GraphInspectorProps) {
  return (
    <div className="p-5">
      {props.selected ? (
        <Details {...props} selected={props.selected} />
      ) : (
        <Overview {...props} />
      )}
    </div>
  );
}
