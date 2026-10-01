import { Suspense } from "react";
import { PageBackLink } from "@/components/page-detail";
import { PageEditor } from "@/components/workspace/page-editor";
import { Loading } from "@/components/workspace/primitives";
import { isCompanyRelationship, isPageType } from "@/lib/brain/types";
import { getWorkspacePages } from "@/lib/workspace/data";
import { CONNECTION_PAGE_SIZE } from "@/lib/workspace/urls";

type SearchParams = Promise<{
  type?: string | string[];
  relationship?: string | string[];
}>;

async function Editor({ searchParams }: { searchParams: SearchParams }) {
  const [params, choices] = await Promise.all([
    searchParams,
    getWorkspacePages({ limit: CONNECTION_PAGE_SIZE, sort: "title" }),
  ]);
  const type = isPageType(params.type) ? params.type : "note";
  const relationship =
    type === "company" && isCompanyRelationship(params.relationship)
      ? params.relationship
      : undefined;
  return (
    <PageEditor
      key={`${type}:${relationship ?? ""}`}
      initialPage={null}
      initialType={type}
      initialRelationships={relationship ? [relationship] : []}
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
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="text-sm">
        <PageBackLink />
      </div>
      <Suspense fallback={<Loading />}>
        <Editor searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
