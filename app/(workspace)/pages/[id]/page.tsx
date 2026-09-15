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
import { Loading } from "@/components/workspace/primitives";

export default function Page({ params }: { params: PageParams }) {
  return (
    <div className="page-detail">
      <div className="detail-topline flex justify-between gap-5 pb-[35px] items-center max-[740px]:pb-[27px]">
        <PageBackLink />
        <Suspense fallback={<span>PAGE</span>}>
          <PageVersion params={params} />
        </Suspense>
      </div>
      <Suspense
        fallback={
          <output
            className="block h-40 animate-pulse rounded-md bg-secondary"
            aria-label="Loading page heading"
          />
        }
      >
        <PageHeader params={params} />
      </Suspense>
      <Suspense fallback={<div className="h-12 border-b border-border mb-8" />}>
        <PageNavigation params={params} />
      </Suspense>
      <div className="reading-layout grid grid-cols-[minmax(0,1fr)_218px] gap-[50px] max-[1200px]:gap-[30px] max-[1200px]:grid-cols-[minmax(0,1fr)_185px] max-[960px]:grid-cols-1">
        <Suspense fallback={<Loading />}>
          <PageBody params={params} />
        </Suspense>
        <Suspense
          fallback={
            <output
              className="block h-48 animate-pulse rounded-md bg-secondary"
              aria-label="Loading connections"
            />
          }
        >
          <PageConnections params={params} />
        </Suspense>
      </div>
    </div>
  );
}
