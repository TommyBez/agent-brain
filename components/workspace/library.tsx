import { ArrowRight, ArrowUpRight, BookOpen, Plus } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { entityTypes } from "@/lib/brain/labels";
import type { PageType } from "@/lib/brain/types";
import { relativeTime } from "@/lib/formatters";
import { getWorkspacePages, getWorkspaceStats } from "@/lib/workspace/data";
import {
  LIBRARY_PAGE_SIZE,
  libraryHref,
  pageHref,
  parseLibraryFilters,
  type RouteSearchParams,
  routeSearchParams,
} from "@/lib/workspace/urls";
import { LibraryCollections, LibraryControls } from "./library-controls";
import { Pagination } from "./pagination";
import { Empty, EntityIcon, PageHeading } from "./primitives";

async function WorkspaceCollections({ type }: { type: PageType | "" }) {
  const stats = await getWorkspaceStats();
  return <LibraryCollections stats={stats} type={type} />;
}

export function LibrarySkeleton() {
  return (
    <div className="@container">
      <output
        aria-label="Loading pages"
        aria-busy="true"
        className="grid gap-5 @xl:grid-cols-2 @4xl:grid-cols-3"
      >
        {[1, 2, 3].map((row) => (
          <div key={row} className="space-y-6 rounded-lg border bg-card p-7">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-3 w-2/5" />
          </div>
        ))}
        <span className="sr-only">Opening your pages…</span>
      </output>
    </div>
  );
}

async function LibraryResults({
  searchParams,
  type,
}: {
  searchParams: Promise<RouteSearchParams>;
  type: PageType | "";
}) {
  const params = routeSearchParams(await searchParams);
  const filters = parseLibraryFilters(params, type);
  const { pages, total } = await getWorkspacePages({
    query: filters.query || undefined,
    type: filters.type || undefined,
    sort: filters.sort,
    limit: LIBRARY_PAGE_SIZE,
    offset: filters.offset,
  });
  return (
    <section
      data-slot="library-results"
      aria-label="Pages"
      className="transition-opacity group-has-[[data-pending=true]]/library:opacity-50"
    >
      <div className="mb-4 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <h2 className="text-sm font-medium text-foreground">
          {filters.query
            ? "Search results"
            : filters.sort === "title"
              ? "Pages A–Z"
              : "Recently updated"}
        </h2>
        <span className="tabular-nums">
          {total} {total === 1 ? "page" : "pages"}
        </span>
      </div>
      {pages.length ? (
        <ul className="grid gap-4 @xl:grid-cols-2 @xl:gap-5 @4xl:grid-cols-3">
          {pages.map((page) => (
            <li key={page.id} className="min-w-0">
              <Link
                href={pageHref(page.id)}
                className="group/page flex h-full flex-col rounded-lg border border-border/80 bg-card p-6 transition-colors hover:border-foreground/35 sm:min-h-80 sm:p-7"
              >
                <div className="mb-5 flex items-center justify-between gap-3 sm:mb-7">
                  <span
                    className={`entity-${page.type} flex items-center gap-2 text-[10px] font-medium tracking-[0.1em] uppercase text-secondary-foreground`}
                  >
                    <EntityIcon type={page.type} size={14} />
                    {page.type}
                  </span>
                  <ArrowUpRight
                    size={15}
                    className="text-muted-foreground transition-colors group-hover/page:text-foreground"
                    aria-hidden="true"
                  />
                </div>
                <h3 className="mb-3 wrap-anywhere font-serif text-[25px] leading-[1.25] tracking-[-0.025em]">
                  {page.title}
                </h3>
                {page.summary && (
                  <p className="mb-6 line-clamp-4 wrap-anywhere text-[13px] leading-[1.75] text-muted-foreground">
                    {page.summary}
                  </p>
                )}
                <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border/60 pt-4 text-[10px] text-muted-foreground">
                  <time dateTime={page.updatedAt}>
                    {relativeTime(page.updatedAt)}
                  </time>
                  {page.tags.length > 0 && (
                    <span
                      className="min-w-0 max-w-[60%] truncate"
                      title={page.tags.join(", ")}
                    >
                      {page.tags.slice(0, 2).join(" / ")}
                    </span>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <Empty
          icon={<BookOpen size={31} strokeWidth={1.2} />}
          title={
            filters.query || filters.type
              ? "No pages found"
              : "Your library is empty"
          }
          description={
            filters.query || filters.type
              ? "Try another phrase or a different collection."
              : "Create a page or connect an agent to save notes from your conversations."
          }
        >
          {!filters.query && (
            <div className="flex flex-wrap justify-center gap-2">
              <Button asChild>
                <Link
                  href={
                    filters.type
                      ? `/pages/new?type=${filters.type}`
                      : "/pages/new"
                  }
                >
                  <Plus size={16} />
                  Create a page
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/agents">
                  Connect an agent
                  <ArrowRight size={15} />
                </Link>
              </Button>
            </div>
          )}
        </Empty>
      )}
      <Pagination
        offset={filters.offset}
        hasMore={filters.offset + pages.length < total}
        href={(offset) => libraryHref({ ...filters, offset })}
        label="Page results"
        previousLabel="Previous"
        nextLabel="Next"
      >
        <span className="text-xs">
          {total ? filters.offset + 1 : 0}–
          {Math.min(filters.offset + pages.length, total)} of {total}
        </span>
      </Pagination>
    </section>
  );
}

export function Library({
  searchParams,
  type = "",
}: {
  searchParams: Promise<RouteSearchParams>;
  type?: PageType | "";
}) {
  const title =
    entityTypes.find((item) => item.id === type)?.label ?? "Library";
  return (
    <div className="group/library @container">
      <PageHeading
        eyebrow={type ? "Library / Collection" : "Personal workspace"}
        title={title}
      >
        <Button asChild>
          <Link href={type ? `/pages/new?type=${type}` : "/pages/new"}>
            <Plus size={16} />
            New page
          </Link>
        </Button>
      </PageHeading>
      <Suspense
        fallback={
          <nav
            className="mb-7 h-12 border-b"
            aria-label="Loading collections"
            aria-busy="true"
          />
        }
      >
        <WorkspaceCollections type={type} />
      </Suspense>
      <Suspense
        fallback={
          <output className="mb-6 block" aria-label="Loading search controls">
            <Skeleton className="h-9 w-full" />
          </output>
        }
      >
        <LibraryControls type={type} />
      </Suspense>
      <Suspense fallback={<LibrarySkeleton />}>
        <LibraryResults searchParams={searchParams} type={type} />
      </Suspense>
    </div>
  );
}
