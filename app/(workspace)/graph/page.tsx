import { Suspense } from "react";
import { KnowledgeGraph } from "@/components/knowledge-graph";
import { Loading, PageHeading } from "@/components/workspace/primitives";
import { RefreshButton } from "@/components/workspace/refresh-button";
import { getWorkspaceGraph } from "@/lib/workspace/data";

export const metadata = { title: "Knowledge graph · Brain" };

async function Graph() {
  return <KnowledgeGraph graph={await getWorkspaceGraph()} />;
}

export default function GraphPage() {
  return (
    <>
      <PageHeading
        eyebrow="THE SPACE BETWEEN IDEAS"
        title="Knowledge graph"
        description="Follow the connections. See a bigger picture."
      >
        <RefreshButton />
      </PageHeading>
      <Suspense fallback={<Loading label="Loading your graph…" />}>
        <Graph />
      </Suspense>
    </>
  );
}
