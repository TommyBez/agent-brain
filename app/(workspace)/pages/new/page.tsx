import { Suspense } from "react";
import { PageBackLink } from "@/components/page-detail";
import { PageEditor } from "@/components/workspace/page-editor";
import { Loading, PageHeading } from "@/components/workspace/primitives";
import { PAGE_TYPES, type PageType } from "@/lib/brain/types";
import { getWorkspacePages } from "@/lib/workspace/data";

type SearchParams = Promise<{ type?: string | string[] }>;

async function Editor({ searchParams }: { searchParams: SearchParams }) {
  const [params, choices] = await Promise.all([
    searchParams,
    getWorkspacePages({ limit: 100 }),
  ]);
  const type =
    typeof params.type === "string" &&
    PAGE_TYPES.includes(params.type as PageType)
      ? (params.type as PageType)
      : "note";
  return (
    <PageEditor
      initialPage={null}
      initialType={type}
      choices={choices.pages.map(({ id, title }) => ({ id, title }))}
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
