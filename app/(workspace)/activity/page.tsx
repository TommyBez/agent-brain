import { Activity, ChevronRight, FileText } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { relativeTime } from "@/components/brain-types";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Pagination } from "@/components/workspace/pagination";
import { Empty, Loading, PageHeading } from "@/components/workspace/primitives";
import { RefreshButton } from "@/components/workspace/refresh-button";
import { getWorkspaceActivity } from "@/lib/workspace/data";
import {
  type PaginationSearchParams,
  paginationOffset,
  WORKSPACE_PAGE_SIZE,
} from "@/lib/workspace/pagination";
import { pageHref } from "@/lib/workspace/urls";

export const metadata = { title: "Activity · a native brain" };

async function ActivityFeed({
  searchParams,
}: {
  searchParams: PaginationSearchParams;
}) {
  const offset = paginationOffset((await searchParams).offset);
  const activity = await getWorkspaceActivity(offset);
  if (!activity.length && offset === 0)
    return (
      <Empty
        icon={<Activity size={31} />}
        title="No activity yet"
        description="Your first saved page will appear here, with its source and version."
      />
    );
  return (
    <>
      <ItemGroup className="overflow-hidden rounded-xl border bg-card">
        {activity.slice(0, WORKSPACE_PAGE_SIZE).map((item) => (
          <Item
            key={item.id}
            className="rounded-none border-0 border-b px-5 py-5 last:border-b-0"
            asChild
          >
            <Link href={pageHref(item.pageId)}>
              <ItemMedia variant="icon">
                <FileText />
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle className="wrap-anywhere">
                  {item.title || "Page updated"}
                </ItemTitle>
                <ItemDescription className="wrap-anywhere">
                  {item.reason || "Page saved"}
                </ItemDescription>
                <ItemDescription className="wrap-anywhere">
                  {item.source || "Workspace"} · Version {item.version}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <time
                  dateTime={item.createdAt}
                  className="text-muted-foreground"
                >
                  {relativeTime(item.createdAt)}
                </time>
                <ChevronRight size={16} />
              </ItemActions>
            </Link>
          </Item>
        ))}
      </ItemGroup>
      <Pagination
        path="/activity"
        offset={offset}
        hasMore={activity.length > WORKSPACE_PAGE_SIZE}
      />
    </>
  );
}

export default function ActivityPage({
  searchParams,
}: {
  searchParams: PaginationSearchParams;
}) {
  return (
    <>
      <PageHeading
        eyebrow="Workspace"
        title="Activity"
        description="Recent changes to your pages, with their sources and versions."
      >
        <RefreshButton />
      </PageHeading>
      <Suspense fallback={<Loading label="Loading activity…" />}>
        <ActivityFeed searchParams={searchParams} />
      </Suspense>
    </>
  );
}
