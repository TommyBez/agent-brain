import { ListTodo } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { KnowledgeGraph } from "@/components/graph/knowledge-graph";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/workspace/pagination";
import { Loading, PageHeading } from "@/components/workspace/primitives";
import { RefreshButton } from "@/components/workspace/refresh-button";
import { entityTypes } from "@/lib/brain/labels";
import { isPageType, type PageType } from "@/lib/brain/types";
import {
  parseTaskOverlayParam,
  withTaskOverlay,
} from "@/lib/graph/task-overlay";
import { getWorkspaceTaskOverlay } from "@/lib/graph/task-overlay-data";
import { tasksEnabled } from "@/lib/tasks/types";
import { getWorkspaceGraph, getWorkspaceStats } from "@/lib/workspace/data";
import { paginationOffset } from "@/lib/workspace/pagination";
import {
  GRAPH_PAGE_SIZE,
  graphHref,
  type RouteSearchParams,
} from "@/lib/workspace/urls";

export const metadata = { title: "Knowledge graph · a native brain" };

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
  const type = isPageType(params.type) ? params.type : "";
  const offset = paginationOffset(params.offset);
  const focus = typeof params.node === "string" ? params.node : undefined;
  const tasksAvailable = tasksEnabled();
  const showTasks = tasksAvailable && parseTaskOverlayParam(params.tasks);
  // Filters and pagination keep the overlay switch as they are.
  const href = (to: PageType | "", toOffset = 0, tasks = showTasks) =>
    withTaskOverlay(graphHref(to, toOffset), tasks);
  const [graph, stats] = await Promise.all([
    getWorkspaceGraph(type, offset),
    getWorkspaceStats(),
  ]);
  // A separate read for the pages already chosen: tasks never take a place in
  // the page window.
  const taskOverlay = showTasks
    ? await getWorkspaceTaskOverlay(graph.nodes.map((node) => node.id))
    : null;
  const end = offset + graph.nodes.length;
  return (
    <>
      <nav
        aria-label="Graph filters"
        className="mb-3 flex flex-wrap items-center gap-1.5"
      >
        <FilterChip
          href={href("")}
          active={!type}
          label="All types"
          count={stats.pages}
        />
        {entityTypes.map((item) => (
          <FilterChip
            key={item.id}
            href={href(item.id)}
            active={type === item.id}
            label={item.label}
            count={stats.byType[item.id] ?? 0}
            type={item.id}
          />
        ))}
        {tasksAvailable && (
          <Button
            variant={showTasks ? "secondary" : "outline"}
            size="sm"
            className="ml-auto"
            asChild
          >
            <Link
              href={href(type, offset, !showTasks)}
              aria-label={showTasks ? "Hide open tasks" : "Show open tasks"}
            >
              <ListTodo aria-hidden="true" />
              Open tasks
              {taskOverlay && (
                <span className="text-xs text-muted-foreground">
                  {taskOverlay.total}
                </span>
              )}
            </Link>
          </Button>
        )}
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
            {taskOverlay &&
              " Open tasks appear as squares beside their pages and do not count as pages."}
          </>
        ) : (
          "No pages to show yet."
        )}
      </p>
      <KnowledgeGraph
        key={`${type}-${offset}`}
        graph={graph}
        initialSelected={focus}
        taskOverlay={taskOverlay}
      />
      <Pagination
        offset={offset}
        hasMore={offset + GRAPH_PAGE_SIZE < graph.total}
        pageSize={GRAPH_PAGE_SIZE}
        href={(offset) => href(type, offset)}
        label="Graph pagination"
        previousLabel="Newer pages"
        nextLabel="Older pages"
      />
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
        eyebrow="Explore"
        title="Knowledge graph"
        description="Explore how your pages connect. Select a page to see its relationships."
      >
        <RefreshButton />
      </PageHeading>
      <Suspense
        fallback={
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
            <div className="flex h-[clamp(420px,62vh,760px)] items-center justify-center rounded-lg border bg-card">
              <Loading label="Laying out your graph…" />
            </div>
            <div className="hidden rounded-lg border bg-card xl:block" />
          </div>
        }
      >
        <Graph searchParams={searchParams} />
      </Suspense>
    </>
  );
}
