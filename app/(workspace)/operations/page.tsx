import { Suspense } from "react";
import { OperationsControls } from "@/components/settings/operations-controls";
import { OperationsSummary } from "@/components/settings/operations-summary";
import { Loading, PageHeading } from "@/components/workspace/primitives";
import { operationsStatus } from "@/lib/operations";
import { getWorkspaceUser } from "@/lib/workspace/session";

export const metadata = { title: "Operations · a native brain" };

export default function OperationsPage() {
  return (
    <>
      <PageHeading
        eyebrow="Settings"
        title="Operations"
        description="Monitor storage, backups, and scheduled maintenance."
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
