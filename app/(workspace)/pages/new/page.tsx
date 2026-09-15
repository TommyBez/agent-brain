import { Suspense } from "react";
import { PageBackLink } from "@/components/page-detail";
import { PageEditor } from "@/components/workspace/page-editor";
import { Loading, PageHeading } from "@/components/workspace/primitives";
import { PAGE_TYPES, type PageType } from "@/lib/brain/types";
import { getWorkspacePages } from "@/lib/workspace/data";
import { CONNECTION_PAGE_SIZE } from "@/lib/workspace/urls";

type SearchParams = Promise<{ type?: string | string[] }>;

async function Editor({ searchParams }: { searchParams: SearchParams }) {
  const [params, choices] = await Promise.all([
    searchParams,
    getWorkspacePages({ limit: CONNECTION_PAGE_SIZE, sort: "title" }),
  ]);
  const type =
    typeof params.type === "string" &&
    PAGE_TYPES.includes(params.type as PageType)
      ? (params.type as PageType)
      : "note";
  return (
    <PageEditor
      key={type}
      initialPage={null}
      initialType={type}
      choices={{
        pages: choices.pages.map(({ id, title }) => ({ id, title })),
        total: choices.total,
      }}
    />
  );
}

export default function NewPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <div className="page-detail">
      <div className="detail-topline pb-[35px]">
        <PageBackLink />
      </div>
      <PageHeading eyebrow="MAKE ROOM FOR A THOUGHT" title="A new page" />
      <Suspense fallback={<Loading />}>
        <Editor searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
