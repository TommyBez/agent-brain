// Contract between nightlyMaintenance and the task phases. Workflow-safe:
// type-only imports, so the orchestrators can import it in the sandbox.
import type { TaskJobKind } from "../tasks/types";

export type TaskPhaseKind = TaskJobKind;

/** `nightly` is the 02:00 pass; `tasks` is Operations "Run now" (task phases only). */
export const TASK_PHASE_SCOPES = ["nightly", "tasks"] as const;
export type TaskPhaseScope = (typeof TASK_PHASE_SCOPES)[number];

/** Why a phase stopped early. It ends `partial` and resumes the next run. */
export const TASK_PHASE_HALTS = [
  "budget",
  "provider",
  "embeddings",
  "limit",
] as const;
export type TaskPhaseHalt = (typeof TASK_PHASE_HALTS)[number];

export type TaskPhaseContext = {
  ownerId: string;
  /** Workflow run ID; also the run ID of consolidation records and spend rows. */
  runId: string;
  runDate: string;
  /** The brain_jobs row being executed and its logical attempt (1-based). */
  jobId: string;
  attempts: number;
  scope: TaskPhaseScope;
};

/** Stored as brain_jobs.result. Phases may add further JSON counters. */
export type TaskPhaseResult = {
  status: "succeeded" | "partial";
  halt: TaskPhaseHalt | null;
  /** Provider requests started by this pass (cache hits excluded). */
  requests: number;
  /** Known cost recorded for this run and purpose (`recordedSpendNano`). */
  spendNano: number;
  [counter: string]: unknown;
};
