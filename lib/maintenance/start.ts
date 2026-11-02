import { getHookByToken, start } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { assertOwner } from "@/lib/brain/utils";
import { tasksEnabledFor } from "@/lib/tasks/feature";
import { nightlyMaintenance } from "@/workflows/nightly";
import {
  dailyWorkflowStatus,
  enabledWorkflowJobKinds,
  queueWorkflowJobs,
  workflowJobsComplete,
} from "./jobs";
import type { TaskPhaseScope } from "./task-phase";

/** The Workflow runtime, job ledger and task manager setting, injectable for tests. */
export interface StartDeps {
  start: (
    workflow: typeof nightlyMaintenance,
    args: Parameters<typeof nightlyMaintenance>,
  ) => Promise<{ runId: string }>;
  getHookByToken: (
    token: string,
  ) => Promise<{ runId: string; metadata?: unknown }>;
  dailyWorkflowStatus: typeof dailyWorkflowStatus;
  queueWorkflowJobs: typeof queueWorkflowJobs;
  /** The owner's task manager setting, read when a run is started. */
  tasksEnabled: (ownerId: string) => Promise<boolean>;
  now?: () => Date;
}

const runtime: StartDeps = {
  start: (workflow, args) => start(workflow, args),
  getHookByToken,
  dailyWorkflowStatus,
  queueWorkflowJobs,
  tasksEnabled: (ownerId) => tasksEnabledFor(ownerId),
};

/** The run holding the owner's lock, if any. Older runs carry no scope. */
async function activeRun(ownerId: string, deps: StartDeps) {
  try {
    const active = await deps.getHookByToken(`brain-nightly:${ownerId}`);
    const metadata = active.metadata as
      | { runDate?: string; scope?: TaskPhaseScope }
      | undefined;
    return {
      runId: active.runId,
      runDate: metadata?.runDate,
      scope: metadata?.scope ?? "nightly",
    };
  } catch (error) {
    if (!HookNotFoundError.is(error)) throw error;
    return null;
  }
}

function today(deps: StartDeps) {
  return (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
}

/** Starts one owner's night. The owner's task manager setting decides here
 * whether it includes the task phases; the run keeps that decision even if
 * the setting changes before it ends.
 */
export async function startNightlyMaintenance(
  ownerId: string,
  trigger: "manual" | "scheduled",
  deps: StartDeps = runtime,
) {
  assertOwner(ownerId);
  const runDate = today(deps);
  const tasks = await deps.tasksEnabled(ownerId);
  const kinds = enabledWorkflowJobKinds(tasks);
  const jobs = await deps.dailyWorkflowStatus(ownerId, runDate);
  if (trigger === "scheduled" && workflowJobsComplete(jobs, kinds))
    return { completed: true, runDate };
  const active = await activeRun(ownerId, deps);
  // A task-only "Run now" does not stand in for the night; queue behind it.
  if (active?.runDate === runDate && active.scope === "nightly")
    return { runId: active.runId, runDate, completed: false };
  const rerunConsolidationFrom =
    trigger === "manual"
      ? (jobs.find((job) => job.kind === "consolidation")?.workflowRunId ??
        undefined)
      : undefined;
  await deps.queueWorkflowJobs(ownerId, runDate, rerunConsolidationFrom, kinds);
  const run = await deps.start(nightlyMaintenance, [
    ownerId,
    runDate,
    rerunConsolidationFrom,
    { scope: "nightly", tasks },
  ]);
  return { runId: run.runId, runDate, completed: false };
}
