import {
  ArrowLeft,
  ArrowRight,
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
import { Card, CardContent } from "@/components/ui/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
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
    <Card className="mb-8" aria-busy={!stats}>
      <CardContent className="grid grid-cols-3 gap-4">
        {[
          { label: "Pages", value: stats?.pages, Icon: BookOpen },
          { label: "Connections", value: stats?.links, Icon: Network },
          { label: "Versions", value: stats?.revisions, Icon: Layers },
        ].map(({ label, value, Icon }) => (
          <div key={label} className="min-w-0 space-y-2">
            <p className="text-sm text-muted-foreground">{label}</p>
            <div className="flex items-center gap-3">
              <strong className="font-serif text-3xl font-normal">
                {value ?? "—"}
              </strong>
              <Icon className="hidden size-4 text-muted-foreground sm:block" />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

async function WorkspaceStats() {
  return <StatsDisplay stats={await getWorkspaceStats()} />;
}

export function LibrarySkeleton() {
  return (
    <output
      aria-label="Loading pages"
      aria-busy="true"
      className="block space-y-2"
    >
      {[1, 2, 3].map((row) => (
        <Item key={row} variant="outline">
          <ItemMedia>
            <Skeleton className="size-8" />
          </ItemMedia>
          <ItemContent>
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </ItemContent>
        </Item>
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
      className="transition-opacity group-has-[[data-pending=true]]/library:opacity-50"
    >
      <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
        <span>{filters.query ? "SEARCH RESULTS" : "YOUR LIBRARY"}</span>
        <span>
          {total} {total === 1 ? "page" : "pages"}
        </span>
      </div>
      {pages.length ? (
        <ul className="space-y-2">
          {pages.map((page) => (
            <li key={page.id}>
              <Item variant="outline" asChild>
                <Link href={pageHref(page.id)}>
                  <ItemMedia
                    variant="icon"
                    className={`text-secondary-foreground entity-${page.type}`}
                  >
                    <EntityIcon type={page.type} />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="wrap-anywhere">
                      {page.title}
                    </ItemTitle>
                    <ItemDescription>
                      {page.summary || "Open to read this page."}
                    </ItemDescription>
                    {page.tags.length > 0 && (
                      <div className="mt-2 hidden flex-wrap gap-1 sm:flex">
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
                  </ItemContent>
                  <ItemActions className="flex-col items-end">
                    <Badge
                      variant="secondary"
                      className={`capitalize type-${page.type}`}
                    >
                      {page.type}
                    </Badge>
                    <time
                      className="hidden text-xs text-muted-foreground sm:block"
                      dateTime={page.updatedAt}
                    >
                      {relativeTime(page.updatedAt)}
                    </time>
                  </ItemActions>
                </Link>
              </Item>
            </li>
          ))}
        </ul>
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
    <div className="group/library">
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
      <div className="mt-8 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>ONE PAGE PER ENTITY. EVERY CONNECTION COUNTS.</span>
        <span>Brain</span>
      </div>
    </div>
  );
}
