import { getHookByToken, start } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { BrainError } from "@/lib/brain/types";
import { assertOwner } from "@/lib/brain/utils";
import { tasksEnabled } from "@/lib/tasks/types";
import { nightlyMaintenance } from "@/workflows/nightly";
import {
  dailyWorkflowStatus,
  enabledWorkflowJobKinds,
  isTaskJobKind,
  queueWorkflowJobs,
  requeueTaskWorkflowJobs,
  workflowJobsComplete,
} from "./jobs";
import type { TaskPhaseScope } from "./task-phase";

/** The Workflow runtime and job ledger, injectable for tests. */
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
  requeueTaskWorkflowJobs: typeof requeueTaskWorkflowJobs;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

const runtime: StartDeps = {
  start: (workflow, args) => start(workflow, args),
  getHookByToken,
  dailyWorkflowStatus,
  queueWorkflowJobs,
  requeueTaskWorkflowJobs,
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

export async function startNightlyMaintenance(
  ownerId: string,
  trigger: "manual" | "scheduled",
  deps: StartDeps = runtime,
) {
  assertOwner(ownerId);
  const runDate = today(deps);
  const kinds = enabledWorkflowJobKinds(deps.env);
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
    { scope: "nightly", tasks: kinds.some(isTaskJobKind) },
  ]);
  return { runId: run.runId, runDate, completed: false };
}

/** Operations "Run now" for the task keeper and task links: requeues only
 * today's two task phases and starts a run that executes only them. A run
 * already holding today's lock with a pending task phase is reused.
 */
export async function startTaskMaintenance(
  ownerId: string,
  deps: StartDeps = runtime,
) {
  assertOwner(ownerId);
  if (!tasksEnabled(deps.env))
    throw new BrainError(
      "TASKS_DISABLED",
      "Task maintenance is not enabled.",
      409,
    );
  const runDate = today(deps);
  const active = await activeRun(ownerId, deps);
  if (active?.runDate === runDate) {
    const jobs = await deps.dailyWorkflowStatus(ownerId, runDate);
    if (
      jobs.some(
        (job) =>
          isTaskJobKind(job.kind) &&
          (job.status === "queued" || job.status === "running"),
      )
    )
      return { runId: active.runId, runDate, completed: false, started: false };
  }
  await deps.requeueTaskWorkflowJobs(ownerId, runDate);
  const run = await deps.start(nightlyMaintenance, [
    ownerId,
    runDate,
    undefined,
    { scope: "tasks", tasks: true },
  ]);
  return { runId: run.runId, runDate, completed: false, started: true };
}
