import { Suspense } from "react";
import {
  PageBackLink,
  type PageParams,
  readPage,
} from "@/components/page-detail";
import { PageEditor } from "@/components/workspace/page-editor";
import { Loading, PageHeading } from "@/components/workspace/primitives";
import { getWorkspacePages } from "@/lib/workspace/data";

async function Editor({ params }: { params: PageParams }) {
  const [page, choices] = await Promise.all([
    readPage(params),
    getWorkspacePages({ limit: 100 }),
  ]);
  return (
    <PageEditor
      key={page.id}
      initialPage={page}
      choices={choices.pages
        .filter((item) => item.id !== page.id)
        .map(({ id, title }) => ({ id, title }))}
    />
  );
}

export default function EditPage({ params }: { params: PageParams }) {
  return (
    <div className="page-detail">
      <div className="detail-topline pb-[35px]">
        <PageBackLink />
      </div>
      <PageHeading eyebrow="REFINE WHAT YOU KNOW" title="Edit page" />
      <Suspense fallback={<Loading />}>
        <Editor params={params} />
      </Suspense>
    </div>
  );
}
