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
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 text-sm text-muted-foreground">
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
      <div className="grid items-start gap-8 lg:grid-cols-3">
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
