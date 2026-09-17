import { Suspense } from "react";
import {
  PageBackLink,
  PageBody,
  PageConnections,
  PageHeader,
  PageNavigation,
  type PageParams,
  PageVersion,
} from "@/components/page-detail";
import { Skeleton } from "@/components/ui/skeleton";
import { Loading } from "@/components/workspace/primitives";

export default function Page({ params }: { params: PageParams }) {
  return (
    <div className="mx-auto max-w-[1100px] space-y-6 sm:space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4 text-[10px] tracking-wide text-muted-foreground">
        <PageBackLink />
        <Suspense fallback={<span>PAGE</span>}>
          <PageVersion params={params} />
        </Suspense>
      </div>
      <Suspense
        fallback={
          <Skeleton className="h-40" aria-label="Loading page heading" />
        }
      >
        <PageHeader params={params} />
      </Suspense>
      <Suspense fallback={<div className="h-12 border-b" />}>
        <PageNavigation params={params} />
      </Suspense>
      <div className="grid grid-cols-1 items-start gap-12 pt-2 lg:grid-cols-[minmax(0,1fr)_15rem] lg:gap-16">
        <Suspense fallback={<Loading />}>
          <PageBody params={params} />
        </Suspense>
        <Suspense
          fallback={
            <Skeleton className="h-48" aria-label="Loading connections" />
          }
        >
          <PageConnections params={params} />
        </Suspense>
      </div>
    </div>
  );
}
