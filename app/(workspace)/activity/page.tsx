import { Activity, ChevronRight, FileText } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { relativeTime } from "@/components/brain-types";
import { Empty, Loading, PageHeading } from "@/components/workspace/primitives";
import { RefreshButton } from "@/components/workspace/refresh-button";
import { getWorkspaceActivity } from "@/lib/workspace/data";
import { pageHref } from "@/lib/workspace/urls";

export const metadata = { title: "Activity · Brain" };

async function ActivityFeed() {
  const activity = await getWorkspaceActivity();
  if (!activity.length)
    return (
      <Empty
        icon={<Activity size={31} />}
        title="Every change has a story."
        description="Your first saved page will appear here, with its source and version."
      />
    );
  return (
    <div className="activity-list border-t border-[var(--line)]">
      {activity.map((item) => (
        <Link
          key={item.id}
          href={pageHref(item.pageId)}
          className="activity-row flex items-center gap-4 w-full border-b border-[var(--line)] text-left p-[22px_10px] max-[740px]:px-0 max-[460px]:gap-[10px]"
        >
          <span className="activity-marker size-[35px] rounded-full bg-[#e8eddf] text-[#8a9a75] flex items-center justify-center max-[460px]:size-[30px] shrink-0">
            <FileText size={17} />
          </span>
          <div>
            <strong>{item.title || "Page updated"}</strong>
            <p>{item.reason || "Page saved"}</p>
            <span>
              {item.source || "Workspace"}
              <span className="dot-separator text-[#a9ae9f] px-[5px]">·</span>
              Version {item.version}
            </span>
          </div>
          <time dateTime={item.createdAt}>{relativeTime(item.createdAt)}</time>
          <ChevronRight size={17} />
        </Link>
      ))}
    </div>
  );
}

export default function ActivityPage() {
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
        <ActivityFeed />
      </Suspense>
    </>
  );
}
