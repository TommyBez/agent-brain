import { Suspense } from "react";
import {
  PageBackLink,
  PageNavigation,
  PageRevision,
  PageRevisionHeader,
} from "@/components/page-detail";
import { Loading } from "@/components/workspace/primitives";

export default function RevisionPage({
  params,
}: {
  params: Promise<{ id: string; version: string }>;
}) {
  return (
    <div className="page-detail">
      <div className="detail-topline flex justify-between gap-5 pb-[35px] items-center">
        <PageBackLink />
        <span>PAGE HISTORY</span>
      </div>
      <Suspense
        fallback={
          <div className="h-40 animate-pulse rounded-md bg-secondary" />
        }
      >
        <PageRevisionHeader params={params} />
      </Suspense>
      <Suspense fallback={<div className="h-12 border-b border-border mb-8" />}>
        <PageNavigation params={params} history />
      </Suspense>
      <Suspense fallback={<Loading />}>
        <PageRevision params={params} />
      </Suspense>
    </div>
  );
}
