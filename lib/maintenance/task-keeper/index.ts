import type {
  TaskPhaseContext,
  TaskPhaseHalt,
  TaskPhaseResult,
} from "../task-phase";
import { TASK_KEEPER_LIMITS } from "./policy";
import {
  finishTaskKeeper,
  keeperDeterministicHygiene,
  keeperDuplicatePair,
  keeperTaskHygiene,
  prepareKeeperHygiene,
  type StepStatus,
} from "./steps";

/** Hygiene proposals only: this phase cannot create tasks or page links. */
export type TaskKeeperResult = TaskPhaseResult & { suggestions: number };
export async function runTaskKeeperPhase(
  context: TaskPhaseContext,
): Promise<TaskKeeperResult> {
  const { ownerId, runId } = context;
  const counts = {
    cappedSuggestions: 0,
    failedHygiene: 0,
    hygieneTasks: 0,
    hygieneReused: 0,
    duplicatePairs: 0,
    expiredSuggestions: 0,
  };
  const result: TaskKeeperResult = {
    status: "succeeded",
    halt: null,
    requests: 0,
    suggestions: 0,
    spendNano: 0,
  };
  let halt = null as TaskPhaseHalt | null;
  let failures = 0;
  let changed = false;
  /** Returns true when the pass must stop. */
  const track = (step: StepStatus): boolean => {
    result.requests += step.requests;
    if (step.halt) {
      halt = step.halt;
      return true;
    }
    if (step.failed) {
      failures++;
      if (failures >= TASK_KEEPER_LIMITS.providerFailures) {
        halt = "provider";
        return true;
      }
    } else failures = 0;
    return false;
  };

  const hygiene = await keeperDeterministicHygiene(ownerId);
  result.suggestions += hygiene.opened;
  counts.expiredSuggestions = hygiene.expired;
  changed ||= hygiene.opened + hygiene.expired > 0;

  // Jev hygiene shares the budget: skip it after a budget or provider halt.
  const hygienePlan =
    halt !== "budget" && halt !== "provider"
      ? await prepareKeeperHygiene(ownerId)
      : { taskIds: [], reused: 0, duplicatePairs: [] };
  counts.hygieneReused = hygienePlan.reused;
  if (halt !== "budget" && halt !== "provider") {
    for (const taskId of hygienePlan.taskIds) {
      const step = await keeperTaskHygiene(ownerId, runId, taskId);
      if (step.failed) counts.failedHygiene++;
      if (track(step)) break;
      counts.hygieneTasks++;
      counts.cappedSuggestions += step.capped;
      result.suggestions += step.opened;
      changed ||= step.opened > 0;
    }
  }
  if (halt !== "budget" && halt !== "provider") {
    for (const pair of hygienePlan.duplicatePairs) {
      const step = await keeperDuplicatePair(ownerId, runId, pair.a, pair.b);
      if (step.failed) counts.failedHygiene++;
      if (track(step)) break;
      counts.duplicatePairs++;
      counts.cappedSuggestions += step.capped;
      result.suggestions += step.opened;
      changed ||= step.opened > 0;
    }
  }

  const finish = await finishTaskKeeper(ownerId, runId, changed);
  result.spendNano = finish.spendNano;
  result.halt = halt;
  result.status = halt || counts.failedHygiene ? "partial" : "succeeded";
  return { ...result, ...counts };
}
