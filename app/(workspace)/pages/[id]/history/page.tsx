import { Suspense } from "react";
import {
  PageBackLink,
  PageHeader,
  PageHistory,
  PageNavigation,
  type PageParams,
  PageVersion,
} from "@/components/page-detail";
import { Skeleton } from "@/components/ui/skeleton";
import { Loading } from "@/components/workspace/primitives";
import type { PaginationSearchParams } from "@/lib/workspace/pagination";

export default function HistoryPage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: PaginationSearchParams;
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 text-sm text-muted-foreground">
        <PageBackLink />
        <Suspense fallback={<span>HISTORY</span>}>
          <PageVersion params={params} />
        </Suspense>
      </div>
      <Suspense fallback={<Skeleton className="h-40" />}>
        <PageHeader params={params} />
      </Suspense>
      <Suspense fallback={<div className="h-12 border-b" />}>
        <PageNavigation params={params} history />
      </Suspense>
      <Suspense fallback={<Loading />}>
        <PageHistory params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
