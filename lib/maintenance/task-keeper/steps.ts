import { loadPages } from "../../brain/pages";
import { BrainError } from "../../brain/types";
import { getPool } from "../../db";
import { systemActor } from "../../tasks/actors";
import { revalidateTasksCache } from "../../workspace/cache";
import {
  BudgetExhaustedError,
  budgetedGateway,
  recordedSpendNano,
} from "../consolidator/budget";
import { evaluatePersisted } from "../consolidator/evaluation-cache";
import { pageEvidenceFingerprint } from "../consolidator/snapshot";
import {
  findConsolidationRecords,
  saveConsolidationRecord,
} from "../consolidator/store";
import type { Evaluate } from "../consolidator/types";
import type { GatewayCall } from "../gateway";
import {
  duplicateUnitId,
  evaluateDuplicatePair,
  evaluateTaskHygiene,
  hygieneUnitId,
  listHygieneTasks,
  loadDuplicatePair,
  loadHygieneTask,
  pendingDuplicatePairs,
  runDeterministicHygiene,
} from "./hygiene";
import { TASK_KEEPER_LIMITS } from "./policy";
import { type StepStatus, stepFailure } from "./step-failure";
import {
  keeperExcludedPageIds,
  keeperKeys,
  tasksAtSuggestionCap,
} from "./store";

export type { StepStatus } from "./step-failure";

// "use step" functions of the task keeper phase. Each returns plain data:
// a budget or a 402 halts the pass, another provider failure fails only the
// current page or item (retried next run), and database errors throw so the
// Workflow retries the step. Logs carry codes, never task or page text.

function metered(ownerId: string, runId: string) {
  const base = budgetedGateway(ownerId, runId, "task_keeper");
  const meter = { requests: 0 };
  const send = (async (path: Parameters<GatewayCall>[0], body: unknown) => {
    try {
      const response = await base(path, body);
      meter.requests++;
      return response;
    } catch (error) {
      if (!(error instanceof BudgetExhaustedError)) meter.requests++;
      throw error;
    }
  }) as GatewayCall;
  const evaluate: Evaluate = (request) =>
    evaluatePersisted(ownerId, runId, request, send, {
      logEvent: "task_keeper.evaluation_error",
    });
  return { send, evaluate, meter };
}

const ok = (requests: number): StepStatus => ({
  requests,
  halt: null,
  failed: false,
});

/** Saves an immutable record; an identical replay is a no-op. */
async function saveOnce(
  ownerId: string,
  runId: string,
  key: string,
  value: unknown,
): Promise<void> {
  try {
    await saveConsolidationRecord(ownerId, runId, key, value);
  } catch (error) {
    if (!(error instanceof BrainError) || error.code !== "RECORD_CONFLICT")
      throw error;
  }
}

export async function keeperDeterministicHygiene(ownerId: string) {
  "use step";
  const actor = await systemActor(ownerId, "task_keeper");
  return runDeterministicHygiene(ownerId, actor.agentId);
}

export type HygienePlan = {
  taskIds: string[];
  reused: number;
  duplicatePairs: { a: string; b: string }[];
};

/** Read existing tasks for hygiene proposals. */
export async function prepareKeeperHygiene(
  ownerId: string,
): Promise<HygienePlan> {
  "use step";
  const excluded = await keeperExcludedPageIds(ownerId);
  const tasks = await listHygieneTasks(ownerId, excluded);
  const pages = await loadPages(getPool(), ownerId, [
    ...new Set(tasks.flatMap((task) => task.pageIds)),
  ]);
  const fingerprints = new Map(
    pages.map((page) => [page.id, pageEvidenceFingerprint(page)]),
  );
  const units = tasks.map((task) => ({
    id: task.id,
    unitId: hygieneUnitId(task, fingerprints),
  }));
  const done = await findConsolidationRecords(
    ownerId,
    units.map((unit) => keeperKeys.hygiene(unit.unitId)),
  );
  // Tasks without a free suggestion slot last: their proposals would wait.
  const full = await tasksAtSuggestionCap(ownerId);
  const pending = units
    .filter((unit) => !done.has(keeperKeys.hygiene(unit.unitId)))
    .sort((a, b) => Number(full.has(a.id)) - Number(full.has(b.id)));
  return {
    taskIds: pending
      .slice(0, TASK_KEEPER_LIMITS.hygieneTasksPerRun)
      .map((unit) => unit.id),
    reused: units.length - pending.length,
    duplicatePairs: (await pendingDuplicatePairs(ownerId)).map((pair) => ({
      a: pair.a.id,
      b: pair.b.id,
    })),
  };
}

export type HygieneStep = StepStatus & { opened: number; capped: number };

export async function keeperTaskHygiene(
  ownerId: string,
  runId: string,
  taskId: string,
): Promise<HygieneStep> {
  "use step";
  const task = await loadHygieneTask(
    ownerId,
    taskId,
    await keeperExcludedPageIds(ownerId),
  );
  if (!task) return { ...ok(0), opened: 0, capped: 0 };
  const { evaluate, meter } = metered(ownerId, runId);
  try {
    const actor = await systemActor(ownerId, "task_keeper");
    const result = await evaluateTaskHygiene(
      ownerId,
      task,
      evaluate,
      actor.agentId,
    );
    // A capped proposal keeps the unit pending: a later run asks again from
    // the evaluation cache and opens it once a slot is free.
    if (!result.capped)
      await saveOnce(ownerId, runId, keeperKeys.hygiene(result.unitId), {
        taskId,
        opened: result.opened,
      });
    return {
      ...ok(meter.requests),
      opened: result.opened,
      capped: result.capped,
    };
  } catch (error) {
    return { ...stepFailure(error, meter.requests), opened: 0, capped: 0 };
  }
}

export async function keeperDuplicatePair(
  ownerId: string,
  runId: string,
  aId: string,
  bId: string,
): Promise<HygieneStep> {
  "use step";
  const pair = await loadDuplicatePair(ownerId, aId, bId);
  if (!pair) return { ...ok(0), opened: 0, capped: 0 };
  const { evaluate, meter } = metered(ownerId, runId);
  try {
    const actor = await systemActor(ownerId, "task_keeper");
    const result = await evaluateDuplicatePair(
      ownerId,
      pair,
      evaluate,
      actor.agentId,
    );
    if (!result.capped)
      await saveOnce(
        ownerId,
        runId,
        keeperKeys.duplicate(duplicateUnitId(pair)),
        {
          a: aId,
          b: bId,
          probability: result.probability,
        },
      );
    return {
      ...ok(meter.requests),
      opened: result.opened ? 1 : 0,
      capped: result.capped ? 1 : 0,
    };
  } catch (error) {
    return { ...stepFailure(error, meter.requests), opened: 0, capped: 0 };
  }
}

export async function finishTaskKeeper(
  ownerId: string,
  runId: string,
  changed: boolean,
) {
  "use step";
  if (changed) revalidateTasksCache(ownerId);
  return {
    spendNano: await recordedSpendNano(ownerId, runId, ["task_keeper"]),
  };
}
