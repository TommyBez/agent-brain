import { Suspense } from "react";
import { OperationsControls } from "@/components/settings/operations-controls";
import { OperationsSummary } from "@/components/settings/operations-summary";
import { KeeperExclusions } from "@/components/tasks/keeper-exclusions";
import { Loading, PageHeading } from "@/components/workspace/primitives";
import { operationsStatus } from "@/lib/operations";
import { getWorkspaceUser } from "@/lib/workspace/session";
import { getTasksEnabled } from "@/lib/workspace/tasks-data";

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
      <Suspense>
        <TaskKeeperExclusions />
      </Suspense>
    </>
  );
}

async function LiveOperations() {
  const user = await getWorkspaceUser();
  const [data, tasks] = await Promise.all([
    operationsStatus(user.id),
    getTasksEnabled(),
  ]);
  return (
    <>
      <OperationsControls
        active={data.jobs.some((job) =>
          ["queued", "running"].includes(job.status),
        )}
      />
      <OperationsSummary data={data} tasks={tasks} />
    </>
  );
}

// Nothing at all, not even a placeholder, while the owner's task manager is off.
async function TaskKeeperExclusions() {
  if (!(await getTasksEnabled())) return null;
  return (
    <Suspense fallback={<Loading />}>
      <KeeperExclusions />
    </Suspense>
  );
}
