import Link from "next/link";
import { Suspense } from "react";
import { entityTypes } from "@/components/brain-types";
import { KnowledgeGraph } from "@/components/knowledge-graph";
import { Button } from "@/components/ui/button";
import { Loading, PageHeading } from "@/components/workspace/primitives";
import { RefreshButton } from "@/components/workspace/refresh-button";
import { PAGE_TYPES, type PageType } from "@/lib/brain/types";
import { getWorkspaceGraph, getWorkspaceStats } from "@/lib/workspace/data";
import { paginationOffset } from "@/lib/workspace/pagination";
import {
  GRAPH_PAGE_SIZE,
  graphHref,
  type RouteSearchParams,
} from "@/lib/workspace/urls";

export const metadata = { title: "Knowledge graph · Brain" };

function FilterChip({
  href,
  active,
  label,
  count,
  type,
}: {
  href: string;
  active: boolean;
  label: string;
  count: number | undefined;
  type?: PageType;
}) {
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      size="sm"
      className={type ? `entity-${type}` : undefined}
      asChild
    >
      <Link href={href} aria-current={active ? "page" : undefined}>
        {type && (
          <span
            aria-hidden="true"
            className="size-2 rounded-full bg-secondary-foreground"
          />
        )}
        {label}
        <span className="text-xs text-muted-foreground">{count ?? "—"}</span>
      </Link>
    </Button>
  );
}

async function Graph({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const params = await searchParams;
  const type =
    typeof params.type === "string" &&
    PAGE_TYPES.includes(params.type as PageType)
      ? (params.type as PageType)
      : "";
  const offset = paginationOffset(params.offset);
  const focus = typeof params.node === "string" ? params.node : undefined;
  const [graph, stats] = await Promise.all([
    getWorkspaceGraph(type, offset),
    getWorkspaceStats(),
  ]);
  const end = offset + graph.nodes.length;
  const paginated = offset > 0 || offset + GRAPH_PAGE_SIZE < graph.total;
  return (
    <>
      <nav
        aria-label="Graph filters"
        className="mb-3 flex flex-wrap items-center gap-1.5"
      >
        <FilterChip
          href="/graph"
          active={!type}
          label="All types"
          count={stats.pages}
        />
        {entityTypes.map((item) => (
          <FilterChip
            key={item.id}
            href={graphHref(item.id)}
            active={type === item.id}
            label={item.label}
            count={stats.byType[item.id] ?? 0}
            type={item.id}
          />
        ))}
      </nav>
      <p className="mb-4 text-sm text-muted-foreground">
        {graph.nodes.length ? (
          <>
            Showing pages{" "}
            <strong className="font-medium text-foreground">
              {offset + 1}–{end}
            </strong>{" "}
            of {graph.total} by last update, with {graph.links.length}{" "}
            {graph.links.length === 1 ? "link" : "links"} between them.
            {graph.total > graph.nodes.length &&
              " Links to pages outside this set appear on each page."}
          </>
        ) : (
          "No pages to show yet."
        )}
      </p>
      <KnowledgeGraph
        key={`${type}-${offset}`}
        graph={graph}
        initialSelected={focus}
      />
      {paginated && (
        <nav
          aria-label="Graph pagination"
          className="mt-6 flex justify-between gap-3"
        >
          {offset > 0 ? (
            <Button variant="outline" asChild>
              <Link
                href={graphHref(type, Math.max(0, offset - GRAPH_PAGE_SIZE))}
              >
                Newer pages
              </Link>
            </Button>
          ) : (
            <span />
          )}
          {offset + GRAPH_PAGE_SIZE < graph.total && (
            <Button variant="outline" asChild>
              <Link href={graphHref(type, offset + GRAPH_PAGE_SIZE)}>
                Older pages
              </Link>
            </Button>
          )}
        </nav>
      )}
    </>
  );
}

export default function GraphPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  return (
    <>
      <PageHeading
        eyebrow="THE SPACE BETWEEN IDEAS"
        title="Knowledge graph"
        description="Follow the connections. See a bigger picture."
      >
        <RefreshButton />
      </PageHeading>
      <Suspense
        fallback={
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
            <div className="flex h-[clamp(420px,62vh,760px)] items-center justify-center rounded-lg border bg-card">
              <Loading label="Laying out your graph…" />
            </div>
            <div className="hidden rounded-lg border bg-card lg:block" />
          </div>
        }
      >
        <Graph searchParams={searchParams} />
      </Suspense>
    </>
  );
}
