import { Suspense } from "react";
import {
  PageBackLink,
  PageHeader,
  PageHistory,
  PageNavigation,
  type PageParams,
  PageVersion,
} from "@/components/page-detail";
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
    <div className="page-detail">
      <div className="detail-topline flex justify-between gap-5 pb-[35px] items-center">
        <PageBackLink />
        <Suspense fallback={<span>HISTORY</span>}>
          <PageVersion params={params} />
        </Suspense>
      </div>
      <Suspense
        fallback={
          <div className="h-40 animate-pulse rounded-md bg-secondary" />
        }
      >
        <PageHeader params={params} />
      </Suspense>
      <Suspense fallback={<div className="h-12 border-b border-border mb-8" />}>
        <PageNavigation params={params} history />
      </Suspense>
      <Suspense fallback={<Loading />}>
        <PageHistory params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
