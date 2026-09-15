import { Suspense } from "react";
import { OperationsControls } from "@/components/settings/operations-controls";
import { OperationsSummary } from "@/components/settings/operations-summary";
import { Loading, PageHeading } from "@/components/workspace/primitives";
import { operationsStatus } from "@/lib/operations";
import { getWorkspaceUser } from "@/lib/workspace/session";

export const metadata = { title: "Operations — Brain" };

export default function OperationsPage() {
  return (
    <>
      <PageHeading
        eyebrow="TAKE CARE OF WHAT YOU KNOW"
        title="Operations"
        description="Storage, safeguards, and the work that happens overnight."
      />
      <Suspense fallback={<Loading />}>
        <LiveOperations />
      </Suspense>
    </>
  );
}

async function LiveOperations() {
  const user = await getWorkspaceUser();
  const data = await operationsStatus(user.id);
  return (
    <>
      <OperationsControls
        active={data.jobs.some((job) =>
          ["queued", "running"].includes(job.status),
        )}
      />
      <OperationsSummary data={data} />
    </>
  );
}
