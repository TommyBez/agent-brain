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

export default function HistoryPage({ params }: { params: PageParams }) {
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
        <PageHistory params={params} />
      </Suspense>
    </div>
  );
}
