import { FatalError } from "workflow";
import { readConsolidationPages } from "../../brain/consolidation";
import { loadPages } from "../../brain/pages";
import type { BrainPage } from "../../brain/types";
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
  findConsolidationRecord,
  findConsolidationRecords,
  readConsolidationRecord,
  saveConsolidationRecord,
} from "../consolidator/store";
import { type Evaluate, POLICY } from "../consolidator/types";
import type { GatewayCall } from "../gateway";
import { maintenanceEmbedding, type SettleOutcome, settleItem } from "./apply";
import {
  type ExtractedItem,
  extractionContext,
  extractionKey,
  extractionRequestBody,
  materializeExtraction,
  parseExtractionResponse,
} from "./extract";
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
import { instantiateRecurrences } from "./recurrences";
import { type ScreenResult, screenPage } from "./screen";
import {
  buildKeeperSnapshot,
  type KeeperLinkedPage,
  type KeeperSnapshot,
  keeperPageUnit,
  linkedPageIds,
} from "./snapshot";
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

export async function keeperRecurrences(ownerId: string, runDate: string) {
  "use step";
  return instantiateRecurrences(
    await systemActor(ownerId, "task_keeper"),
    runDate,
  );
}

export async function keeperDeterministicHygiene(ownerId: string) {
  "use step";
  const actor = await systemActor(ownerId, "task_keeper");
  return runDeterministicHygiene(ownerId, actor.agentId);
}

export type KeeperPlan = {
  /**
   * Changed in-scope pages, newest first, bounded by pagesPerRun; pages left
   * pending by the suggestion cap or Jev's size limit come last.
   */
  pageIds: string[];
  pendingPages: number;
  reusedPages: number;
  excludedPages: number;
};

/** All pages on the first run, then only pages whose evidence changed. */
export async function prepareTaskKeeper(ownerId: string): Promise<KeeperPlan> {
  "use step";
  const excluded = new Set(await keeperExcludedPageIds(ownerId));
  const pages = await readConsolidationPages(ownerId);
  const units = pages
    .filter((page) => !excluded.has(page.id))
    .map((page) => ({ page, ...keeperPageUnit(page) }));
  const done = await findConsolidationRecords(
    ownerId,
    units.map((unit) => keeperKeys.page(unit.unitId)),
    ["summary"],
  );
  const pending = units.filter(
    (unit) => !done.has(keeperKeys.page(unit.unitId)),
  );
  const deferredKeys = (unitId: string) => [
    keeperKeys.capped(unitId),
    keeperKeys.oversized(unitId, POLICY.evaluationCharacters),
  ];
  const deferred = await findConsolidationRecords(
    ownerId,
    pending.flatMap((unit) => deferredKeys(unit.unitId)),
  );
  const waiting = new Set(
    pending
      .filter((unit) =>
        deferredKeys(unit.unitId).some((key) => deferred.has(key)),
      )
      .map((unit) => unit.unitId),
  );
  pending.sort(
    (a, b) =>
      Number(waiting.has(a.unitId)) - Number(waiting.has(b.unitId)) ||
      b.page.updatedAt.localeCompare(a.page.updatedAt) ||
      a.page.id.localeCompare(b.page.id),
  );
  return {
    pageIds: pending
      .slice(0, TASK_KEEPER_LIMITS.pagesPerRun)
      .map((unit) => unit.page.id),
    pendingPages: pending.length,
    reusedPages: units.length - pending.length,
    excludedPages: pages.length - units.length,
  };
}

export type HygienePlan = {
  taskIds: string[];
  reused: number;
  duplicatePairs: { a: string; b: string }[];
};

/** After extraction, so tasks created tonight are checked tonight. */
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

async function linkedPages(
  ownerId: string,
  page: BrainPage,
): Promise<KeeperLinkedPage[]> {
  const ids = linkedPageIds(page);
  if (!ids.length) return [];
  const { rows } = await getPool().query(
    `SELECT id, slug, title, type, aliases FROM brain_pages
     WHERE owner_id = $1 AND id = ANY($2::uuid[]) AND type IN ('person', 'project')
     ORDER BY id`,
    [ownerId, ids],
  );
  return rows;
}

/** The page as first read in this run; later steps and retries reuse it. */
async function snapshotFor(
  ownerId: string,
  runId: string,
  page: BrainPage,
  unitId: string,
): Promise<KeeperSnapshot> {
  const key = keeperKeys.snapshot(unitId);
  const existing = await readConsolidationRecord<KeeperSnapshot>(
    ownerId,
    runId,
    key,
  );
  if (existing) return existing;
  const snapshot = buildKeeperSnapshot(page, await linkedPages(ownerId, page));
  await saveOnce(ownerId, runId, key, snapshot);
  return (
    (await readConsolidationRecord<KeeperSnapshot>(ownerId, runId, key)) ??
    snapshot
  );
}

async function loadSnapshot(
  ownerId: string,
  runId: string,
  unitId: string,
): Promise<KeeperSnapshot> {
  const snapshot = await readConsolidationRecord<KeeperSnapshot>(
    ownerId,
    runId,
    keeperKeys.snapshot(unitId),
  );
  if (!snapshot)
    throw new FatalError("The task keeper page snapshot is unavailable.");
  return snapshot;
}

export type ScreenStep = StepStatus & {
  status: ScreenResult["status"] | "missing" | "excluded" | "reused" | "error";
  unitId: string | null;
  candidates: number[];
};

export async function screenKeeperPage(
  ownerId: string,
  runId: string,
  pageId: string,
): Promise<ScreenStep> {
  "use step";
  const { evaluate, meter } = metered(ownerId, runId);
  const [page] = await loadPages(getPool(), ownerId, [pageId]);
  const base = { unitId: null, candidates: [] as number[] };
  if (!page) return { ...ok(0), ...base, status: "missing" };
  if ((await keeperExcludedPageIds(ownerId)).includes(page.id))
    return { ...ok(0), ...base, status: "excluded" };
  const { unitId } = keeperPageUnit(page);
  if (await findConsolidationRecord(ownerId, keeperKeys.page(unitId)))
    return { ...ok(0), ...base, unitId, status: "reused" };
  // An oversized page is never marked done; once known, later runs report it
  // without a new snapshot or request until its evidence changes.
  const oversized = keeperKeys.oversized(unitId, POLICY.evaluationCharacters);
  if (await findConsolidationRecord(ownerId, oversized))
    return { ...ok(0), ...base, unitId, status: "oversized" };
  const snapshot = await snapshotFor(ownerId, runId, page, unitId);
  try {
    const result = await screenPage(snapshot, evaluate);
    if (result.status === "oversized")
      await saveOnce(ownerId, runId, oversized, {
        pageId: snapshot.page.id,
        version: snapshot.page.version,
      });
    else if (result.status !== "candidates")
      await saveOnce(ownerId, runId, keeperKeys.page(unitId), {
        pageId: snapshot.page.id,
        version: snapshot.page.version,
        status: result.status,
      });
    return {
      ...ok(meter.requests),
      status: result.status,
      unitId,
      candidates: result.status === "candidates" ? result.candidates : [],
    };
  } catch (error) {
    return {
      ...stepFailure(error, meter.requests),
      ...base,
      unitId,
      status: "error",
    };
  }
}

export type ExtractStep = StepStatus & { key: string | null; count: number };

export async function extractKeeperPage(
  ownerId: string,
  runId: string,
  unitId: string,
  candidates: number[],
): Promise<ExtractStep> {
  "use step";
  const snapshot = await loadSnapshot(ownerId, runId, unitId);
  const context = extractionContext(snapshot, candidates);
  const body = extractionRequestBody(context.content);
  const key = keeperKeys.extraction(extractionKey(body));
  const cached = await findConsolidationRecord<{ items: ExtractedItem[] }>(
    ownerId,
    key,
  );
  if (cached) return { ...ok(0), key, count: cached.items.length };
  const { send, meter } = metered(ownerId, runId);
  try {
    const response = await send<Parameters<typeof parseExtractionResponse>[0]>(
      "chat/completions",
      body,
    );
    const items = materializeExtraction(
      snapshot,
      parseExtractionResponse(response),
      context,
    );
    await saveOnce(ownerId, runId, key, { items });
    const stored = await findConsolidationRecord<{ items: ExtractedItem[] }>(
      ownerId,
      key,
    );
    return {
      ...ok(meter.requests),
      key,
      count: (stored ?? { items }).items.length,
    };
  } catch (error) {
    return { ...stepFailure(error, meter.requests), key: null, count: 0 };
  }
}

export type SettleStep = StepStatus & {
  outcome: SettleOutcome | "error";
  opened: boolean;
  /** new_source refused only by the 3-open cap: the page stays pending. */
  capped: boolean;
  dropped: string[];
};

export async function settleKeeperItem(
  ownerId: string,
  runId: string,
  unitId: string,
  extraction: string,
  index: number,
): Promise<SettleStep> {
  "use step";
  const snapshot = await loadSnapshot(ownerId, runId, unitId);
  const record = await findConsolidationRecord<{ items: ExtractedItem[] }>(
    ownerId,
    extraction,
  );
  const item = record?.items[index];
  if (!item) throw new FatalError("The task keeper extraction is unavailable.");
  const { evaluate, meter } = metered(ownerId, runId);
  try {
    const result = await settleItem(snapshot, item, {
      actor: await systemActor(ownerId, "task_keeper"),
      evaluate,
      embed: maintenanceEmbedding(),
    });
    if (result.identity)
      for (const passage of result.identity.passages)
        await saveOnce(
          ownerId,
          runId,
          keeperKeys.identity(passage, result.identity.extraction),
          { pageId: snapshot.page.id },
        );
    if (result.capped)
      await saveOnce(ownerId, runId, keeperKeys.capped(unitId), {
        pageId: snapshot.page.id,
      });
    return {
      ...ok(meter.requests),
      outcome: result.outcome,
      opened: result.opened ?? false,
      capped: result.capped ?? false,
      dropped: result.dropped ?? [],
    };
  } catch (error) {
    return {
      ...stepFailure(error, meter.requests),
      outcome: "error",
      opened: false,
      capped: false,
      dropped: [],
    };
  }
}

export async function completeKeeperPage(
  ownerId: string,
  runId: string,
  unitId: string,
  summary: Record<string, number | string>,
) {
  "use step";
  const snapshot = await loadSnapshot(ownerId, runId, unitId);
  await saveOnce(ownerId, runId, keeperKeys.page(unitId), {
    pageId: snapshot.page.id,
    version: snapshot.page.version,
    status: "processed",
    summary,
  });
}

/** `capped`: proposals refused only by the 3-open cap; the unit stays pending. */
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
