import { getHookByToken, start } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { assertOwner } from "@/lib/brain/utils";
import { nightlyMaintenance } from "@/workflows/nightly";
import { dailyWorkflowStatus, queueWorkflowJobs } from "./jobs";

export async function startNightlyMaintenance(
  ownerId: string,
  trigger: "manual" | "scheduled",
) {
  assertOwner(ownerId);
  const runDate = new Date().toISOString().slice(0, 10);
  const jobs = await dailyWorkflowStatus(ownerId, runDate);
  if (
    trigger === "scheduled" &&
    jobs.length === 3 &&
    jobs.every((job) => ["succeeded", "partial"].includes(job.status))
  )
    return { completed: true, runDate };
  try {
    const active = await getHookByToken(`brain-nightly:${ownerId}`);
    if (
      (active.metadata as { runDate?: string } | undefined)?.runDate === runDate
    )
      return { runId: active.runId, runDate, completed: false };
  } catch (error) {
    if (!HookNotFoundError.is(error)) throw error;
  }
  await queueWorkflowJobs(ownerId, runDate);
  const rerunConsolidationFrom =
    trigger === "manual"
      ? (jobs.find((job) => job.kind === "consolidation")?.workflowRunId ??
        undefined)
      : undefined;
  const run = await start(nightlyMaintenance, [
    ownerId,
    runDate,
    rerunConsolidationFrom,
  ]);
  return { runId: run.runId, runDate, completed: false };
}
