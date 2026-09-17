import { Suspense } from "react";
import {
  PageBackLink,
  type PageParams,
  readPage,
} from "@/components/page-detail";
import { PageEditor } from "@/components/workspace/page-editor";
import { Loading } from "@/components/workspace/primitives";
import { getWorkspacePages } from "@/lib/workspace/data";
import { CONNECTION_PAGE_SIZE } from "@/lib/workspace/urls";

async function Editor({ params }: { params: PageParams }) {
  const [page, choices] = await Promise.all([
    readPage(params),
    getWorkspacePages({ limit: CONNECTION_PAGE_SIZE, sort: "title" }),
  ]);
  return (
    <PageEditor
      key={page.id}
      initialPage={page}
      choices={{
        pages: choices.pages.map(({ id, title }) => ({ id, title })),
        total: choices.total,
      }}
    />
  );
}

export default function EditPage({ params }: { params: PageParams }) {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="text-sm">
        <PageBackLink />
      </div>
      <Suspense fallback={<Loading />}>
        <Editor params={params} />
      </Suspense>
    </div>
  );
}
