import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Library, LibrarySkeleton } from "@/components/workspace/library";
import { PageHeading } from "@/components/workspace/primitives";
import { entityTypes } from "@/lib/brain/labels";
import {
  collectionPaths,
  collectionTypeFromPathname,
} from "@/lib/workspace/urls";

export async function generateMetadata({ params }: PageProps<"/[collection]">) {
  const { collection } = await params;
  const type = collectionTypeFromPathname(`/${collection}`);
  if (!type) notFound();
  return {
    title: `${entityTypes.find((item) => item.id === type)?.label} · a native brain`,
  };
}
async function CollectionContent({
  params,
  searchParams,
}: PageProps<"/[collection]">) {
  const { collection } = await params;
  const type = collectionTypeFromPathname(`/${collection}`);
  if (!type) notFound();
  return <Library type={type} searchParams={searchParams} />;
}

export function generateStaticParams() {
  return Object.values(collectionPaths).map((path) => ({
    collection: path.slice(1),
  }));
}

export default function CollectionPage(props: PageProps<"/[collection]">) {
  return (
    <Suspense
      fallback={
        <div>
          <PageHeading eyebrow="Library / Collection" title="Collection" />
          <LibrarySkeleton />
        </div>
      }
    >
      <CollectionContent
        params={props.params}
        searchParams={props.searchParams}
      />
    </Suspense>
  );
}
