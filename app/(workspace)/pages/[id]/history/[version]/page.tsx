import { Suspense } from "react";
import {
  PageBackLink,
  PageNavigation,
  PageRevision,
  PageRevisionHeader,
} from "@/components/page-detail";
import { Skeleton } from "@/components/ui/skeleton";
import { Loading } from "@/components/workspace/primitives";

export default function RevisionPage({
  params,
}: {
  params: Promise<{ id: string; version: string }>;
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 text-sm text-muted-foreground">
        <PageBackLink />
        <span>PAGE HISTORY</span>
      </div>
      <Suspense fallback={<Skeleton className="h-40" />}>
        <PageRevisionHeader params={params} />
      </Suspense>
      <Suspense fallback={<div className="h-12 border-b" />}>
        <PageNavigation params={params} history />
      </Suspense>
      <Suspense fallback={<Loading />}>
        <PageRevision params={params} />
      </Suspense>
    </div>
  );
}
