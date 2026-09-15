import Link from "next/link";
import { Suspense } from "react";
import { entityTypes } from "@/components/brain-types";
import { KnowledgeGraph } from "@/components/knowledge-graph";
import { Button } from "@/components/ui/button";
import { Loading, PageHeading } from "@/components/workspace/primitives";
import { RefreshButton } from "@/components/workspace/refresh-button";
import { PAGE_TYPES, type PageType } from "@/lib/brain/types";
import { getWorkspaceGraph } from "@/lib/workspace/data";
import { paginationOffset } from "@/lib/workspace/pagination";
import {
  GRAPH_PAGE_SIZE,
  graphHref,
  type RouteSearchParams,
} from "@/lib/workspace/urls";

export const metadata = { title: "Knowledge graph · Brain" };

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
  const graph = await getWorkspaceGraph(type, offset);
  return (
    <>
      <nav aria-label="Graph filters" className="mb-4 flex flex-wrap gap-2">
        <Button variant={type ? "ghost" : "secondary"} asChild>
          <Link href="/graph" aria-current={!type ? "page" : undefined}>
            All types
          </Link>
        </Button>
        {entityTypes.map((item) => (
          <Button
            key={item.id}
            variant={type === item.id ? "secondary" : "ghost"}
            asChild
          >
            <Link
              href={graphHref(item.id)}
              aria-current={type === item.id ? "page" : undefined}
            >
              <span
                className={`size-2 rounded-full bg-secondary-foreground entity-${item.id}`}
              />
              {item.label}
            </Link>
          </Button>
        ))}
      </nav>
      <p className="text-xs text-muted-foreground mb-4">
        {graph.nodes.length
          ? `${offset + 1}–${offset + graph.nodes.length}`
          : "0"}{" "}
        of {graph.total} pages · {graph.links.length} links between these pages.
        {graph.total > graph.nodes.length &&
          " Open a page to see all its connections."}
      </p>
      <KnowledgeGraph key={`${type}-${offset}`} graph={graph} />
      {(offset > 0 || offset + GRAPH_PAGE_SIZE < graph.total) && (
        <nav
          aria-label="Graph pagination"
          className="flex justify-between gap-3 mt-6"
        >
          {offset > 0 ? (
            <Button variant="outline" asChild>
              <Link
                href={graphHref(type, Math.max(0, offset - GRAPH_PAGE_SIZE))}
              >
                Previous pages
              </Link>
            </Button>
          ) : (
            <span />
          )}
          {offset + GRAPH_PAGE_SIZE < graph.total && (
            <Button variant="outline" asChild>
              <Link href={graphHref(type, offset + GRAPH_PAGE_SIZE)}>
                Next pages
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
      <Suspense fallback={<Loading label="Loading your graph…" />}>
        <Graph searchParams={searchParams} />
      </Suspense>
    </>
  );
}
