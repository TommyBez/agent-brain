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

export const metadata = { title: "Activity · Brain" };

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
        title="Every change has a story."
        description="Your first saved page will appear here, with its source and version."
      />
    );
  return (
    <>
      <ItemGroup>
        {activity.slice(0, WORKSPACE_PAGE_SIZE).map((item) => (
          <Item key={item.id} asChild>
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
        eyebrow="A RECORD OF CHANGE"
        title="Activity"
        description="The small additions that make a lasting memory."
      >
        <RefreshButton />
      </PageHeading>
      <Suspense fallback={<Loading label="Loading activity…" />}>
        <ActivityFeed searchParams={searchParams} />
      </Suspense>
    </>
  );
}
