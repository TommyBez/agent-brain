import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Layers,
  Network,
  Plus,
} from "lucide-react";
import { permanentRedirect, redirect } from "next/navigation";
import { Suspense } from "react";
import {
  entityTypes,
  relativeTime,
  type Stats,
} from "@/components/brain-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PAGE_TYPES, type PageType } from "@/lib/brain/types";
import { getWorkspacePages, getWorkspaceStats } from "@/lib/workspace/data";
import {
  collectionHref,
  LIBRARY_PAGE_SIZE,
  libraryHref,
  pageHref,
  parseLibraryFilters,
  type RouteSearchParams,
  routeSearchParams,
} from "@/lib/workspace/urls";
import { LibraryControls } from "./library-controls";
import { Empty, EntityIcon, PageHeading } from "./primitives";
import { WorkspaceLink as Link } from "./search-navigation";

function StatsDisplay({ stats }: { stats?: Stats }) {
  return (
    <Card
      className="workspace-stats grid grid-cols-[1fr_1fr_1fr_1.25fr] gap-0 mb-[35px] max-[1200px]:grid-cols-[repeat(3,1fr)] max-[740px]:mb-[26px]"
      aria-busy={!stats}
    >
      <div>
        <span>Pages in your brain</span>
        <strong>
          {stats?.pages ?? "—"}
          <BookOpen size={19} />
        </strong>
      </div>
      <div>
        <span>Connections made</span>
        <strong>
          {stats?.links ?? "—"}
          <Network size={19} />
        </strong>
      </div>
      <div>
        <span>Versions preserved</span>
        <strong>
          {stats?.revisions ?? "—"}
          <Layers size={19} />
        </strong>
      </div>
      <div className="stats-note">
        <span className="tiny-spark">✳</span>
        <p>
          A growing body of knowledge.
          <br />
          <strong>Always yours to keep.</strong>
        </p>
      </div>
    </Card>
  );
}

async function WorkspaceStats() {
  return <StatsDisplay stats={await getWorkspaceStats()} />;
}

export function LibrarySkeleton() {
  return (
    <output aria-label="Loading pages" aria-busy="true" className="space-y-0">
      <div className="text-[8px] tracking-[.16em] text-muted-foreground mb-3">
        YOUR LIBRARY
      </div>
      {[1, 2, 3].map((row) => (
        <div
          key={row}
          className="flex gap-4 items-center py-6 border-t border-[var(--line)]"
        >
          <span className="size-10 rounded bg-muted animate-pulse" />
          <div className="space-y-3 flex-1">
            <span className="block h-4 w-2/5 rounded bg-muted animate-pulse" />
            <span className="block h-3 w-3/5 rounded bg-muted animate-pulse" />
          </div>
        </div>
      ))}
      <span className="sr-only">Opening your pages…</span>
    </output>
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
  const legacyPage = params.get("page");
  if (legacyPage) redirect(pageHref(legacyPage));
  const legacyType = params.get("type");
  if (!type && PAGE_TYPES.includes(legacyType as PageType)) {
    params.delete("type");
    const pathname = collectionHref(legacyType as PageType);
    permanentRedirect(params.size ? `${pathname}?${params}` : pathname);
  }
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
      className="transition-opacity"
    >
      <div className="section-caption flex items-center justify-between text-[#939c86] mb-3 text-[9px] tracking-[.09em]">
        <span>{filters.query ? "SEARCH RESULTS" : "YOUR LIBRARY"}</span>
        <span>
          {total} {total === 1 ? "page" : "pages"}
        </span>
      </div>
      {pages.length ? (
        <div className="page-list border-t border-[var(--line)]">
          <div className="list-head text-[8px] text-[#9aa08e] tracking-[.12em] h-[37px] px-[11px] border-b border-[var(--line)]">
            <span>PAGE</span>
            <span>TYPE</span>
            <span>UPDATED</span>
            <span />
          </div>
          {pages.map((page) => (
            <Link
              key={page.id}
              href={pageHref(page.id)}
              className="page-row group/page-row whitespace-normal w-full hover:bg-accent text-left p-[20px_11px] border-b border-[var(--line)] transition-colors min-h-[97px] min-[1600px]:min-h-[105px] max-[960px]:p-[17px_5px]"
            >
              <div className="page-row-main flex gap-[15px] items-start min-w-0 max-[960px]:gap-[10px]">
                <span
                  className={`entity-symbol w-[37px] h-10 shrink-0 flex items-center justify-center bg-secondary border border-border rounded-md text-secondary-foreground max-[960px]:w-[31px] max-[960px]:h-[34px] entity-${page.type}`}
                >
                  <EntityIcon type={page.type} size={19} />
                </span>
                <div>
                  <strong>{page.title}</strong>
                  <p>{page.summary || "Open to read this page."}</p>
                  {page.tags.length > 0 && (
                    <div className="row-tags flex flex-wrap gap-[6px] mt-[7px] max-[460px]:hidden">
                      {page.tags.slice(0, 3).map((tag) => (
                        <Badge
                          key={tag}
                          variant="secondary"
                          className="max-w-full"
                        >
                          <span className="truncate" title={tag}>
                            {tag}
                          </span>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <Badge
                variant="secondary"
                className={`justify-self-start capitalize type-${page.type}`}
              >
                {page.type}
              </Badge>
              <time dateTime={page.updatedAt}>
                {relativeTime(page.updatedAt)}
              </time>
              <ArrowUpRight
                className="row-arrow text-muted-foreground opacity-0 group-hover/page-row:opacity-100 group-focus-visible/page-row:opacity-100 transition-opacity"
                size={17}
              />
            </Link>
          ))}
        </div>
      ) : (
        <Empty
          icon={<BookOpen size={31} strokeWidth={1.2} />}
          title={
            filters.query || filters.type
              ? "Nothing here, yet."
              : "Begin with something worth remembering."
          }
          description={
            filters.query || filters.type
              ? "Try another phrase or a different collection."
              : "Add your first page, or connect an agent and let useful knowledge emerge from your conversations."
          }
        >
          {!filters.query && (
            <div className="empty-actions flex gap-[10px] justify-center mt-7 max-[460px]:flex-col max-[460px]:max-w-[200px] max-[460px]:mx-auto">
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
      {(filters.offset > 0 || filters.offset + pages.length < total) && (
        <nav
          aria-label="Page results"
          className="flex items-center justify-between gap-4 mt-6 text-xs"
        >
          <span>
            {total ? filters.offset + 1 : 0}–
            {Math.min(filters.offset + pages.length, total)} of {total}
          </span>
          <div className="flex gap-3">
            {filters.offset > 0 && (
              <Button asChild variant="outline">
                <Link
                  href={libraryHref({
                    ...filters,
                    offset: Math.max(0, filters.offset - LIBRARY_PAGE_SIZE),
                  })}
                >
                  <ArrowLeft size={14} />
                  Previous
                </Link>
              </Button>
            )}
            {filters.offset + pages.length < total && (
              <Button asChild variant="outline">
                <Link
                  href={libraryHref({
                    ...filters,
                    offset: filters.offset + LIBRARY_PAGE_SIZE,
                  })}
                >
                  Next
                  <ArrowRight size={14} />
                </Link>
              </Button>
            )}
          </div>
        </nav>
      )}
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
    entityTypes.find((item) => item.id === type)?.label ?? "All pages";
  return (
    <div className="library-view">
      <PageHeading
        eyebrow="THE KNOWLEDGE DESK"
        title={title}
        description={
          type
            ? `Your ${title.toLowerCase()}, with the context that matters.`
            : "Everything you know. A little more connected."
        }
      >
        <Button asChild>
          <Link href={type ? `/pages/new?type=${type}` : "/pages/new"}>
            <Plus size={16} />
            New page
          </Link>
        </Button>
      </PageHeading>
      <Suspense fallback={<StatsDisplay />}>
        <WorkspaceStats />
      </Suspense>
      <Suspense
        fallback={
          <output
            className="block h-[39px] mb-[25px] bg-muted rounded-md animate-pulse"
            aria-label="Loading search controls"
          />
        }
      >
        <LibraryControls type={type} />
      </Suspense>
      <Suspense fallback={<LibrarySkeleton />}>
        <LibraryResults searchParams={searchParams} type={type} />
      </Suspense>
      <div className="library-footer mt-[29px] pt-[13px] flex items-center justify-between text-[#a6ad9a] text-[7px] tracking-[.14em] max-[740px]:text-[6px]">
        <span>ONE PAGE PER ENTITY. EVERY CONNECTION COUNTS.</span>
        <span>Brain</span>
      </div>
    </div>
  );
}
