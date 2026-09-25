import { FatalError, RetryableError } from "workflow";
import { BrainError } from "../../brain/types";
import { revalidateWorkspaceCache } from "../../workspace/cache";
import { GatewayRequestError } from "../gateway";
import { analyzeTask } from "./analysis";
import { draftChanges, materializeDraft } from "./editor";
import { evaluateJev, JEV_MODEL } from "./jev";
import { planOperations, selectIndependentPlans } from "./planner";
import { buildSnapshot, createAnalysisTasks, fingerprint } from "./snapshot";
import {
  applyConsolidationChangeSet,
  beginConsolidationRun,
  findConsolidationRecord,
  findConsolidationRecords,
  finishConsolidationRun,
  readConsolidationPages,
  readConsolidationRecord,
  saveConsolidationRecord,
} from "./store";
import {
  type AnalysisResult,
  type AnalysisTask,
  type ChangeSet,
  type DecisionRecord,
  type Draft,
  type Evaluation,
  type EvaluationRequest,
  type OperationPlan,
  POLICY,
  type Snapshot,
  type Verification,
} from "./types";
import { verifyChangeSet } from "./verifier";

function failProvider(error: unknown): never {
  if (error instanceof FatalError || error instanceof RetryableError)
    throw error;
  if (error instanceof GatewayRequestError && error.retryable)
    throw new RetryableError(error.message, {
      retryAfter: error.retryAfterMs ?? 10_000,
    });
  if (error instanceof GatewayRequestError) throw new FatalError(error.message);
  const code =
    error && typeof error === "object" && "code" in error ? error.code : null;
  if (
    typeof code === "string" &&
    (/^08\w{3}$/.test(code) ||
      [
        "40001",
        "40P01",
        "53300",
        "57P01",
        "57P02",
        "57P03",
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "EPIPE",
      ].includes(code))
  )
    throw new RetryableError(
      "Consolidation database is temporarily unavailable.",
      { retryAfter: 10_000 },
    );
  throw new FatalError("Consolidation step could not produce a valid result.");
}

function integerSetting(name: string, fallback: number, ceiling: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling)
    throw new FatalError(`Invalid ${name}`);
  return value;
}

export async function initializeConsolidation(ownerId: string, runId: string) {
  "use step";
  await beginConsolidationRun(ownerId, runId);
  return {
    maxWaves: integerSetting("CONSOLIDATION_MAX_WAVES", POLICY.maxWaves, 100),
    taskBudget: integerSetting(
      "CONSOLIDATION_TASK_BUDGET",
      POLICY.tasksPerRun,
      1_000_000,
    ),
    concurrency: integerSetting(
      "CONSOLIDATION_CONCURRENCY",
      POLICY.concurrency,
      32,
    ),
    repairs: POLICY.draftRepairs,
    expansions: POLICY.contextExpansions,
  };
}

export async function snapshotConsolidation(ownerId: string, runId: string) {
  "use step";
  const snapshot = buildSnapshot(await readConsolidationPages(ownerId));
  const key = `snapshot:${snapshot.id}`;
  // The first timestamp belongs to the immutable snapshot; content identity is stable.
  const existing = await readConsolidationRecord<Snapshot>(ownerId, runId, key);
  if (existing) return existing;
  await saveConsolidationRecord(ownerId, runId, key, snapshot);
  return snapshot;
}

async function loadSnapshot(
  ownerId: string,
  runId: string,
  snapshotId: string,
): Promise<Snapshot> {
  const snapshot = await readConsolidationRecord<Snapshot>(
    ownerId,
    runId,
    `snapshot:${snapshotId}`,
  );
  if (!snapshot || snapshot.id !== snapshotId)
    throw new FatalError(
      "The immutable consolidation snapshot is unavailable.",
    );
  return snapshot;
}

export async function prepareConsolidationScan(
  ownerId: string,
  runId: string,
  snapshotId: string,
  budget: number,
) {
  "use step";
  const snapshot = await loadSnapshot(ownerId, runId, snapshotId);
  const tasks = createAnalysisTasks(snapshot);
  const cached: AnalysisResult[] = [];
  const pending: AnalysisTask[] = [];
  const records = await findConsolidationRecords<
    Omit<AnalysisResult, "judgments">
  >(
    ownerId,
    tasks.map((task) => `analysis:${task.id}`),
    ["judgments"],
  );
  for (const task of tasks) {
    const result = records.get(`analysis:${task.id}`);
    if (result?.status === "complete")
      cached.push({ ...result, judgments: [] });
    else pending.push(task);
  }
  return {
    tasks: pending.slice(0, budget),
    cached,
    total: tasks.length,
    remaining: Math.max(0, pending.length - budget),
  };
}

async function evaluatePersisted(
  ownerId: string,
  runId: string,
  request: EvaluationRequest,
): Promise<Evaluation> {
  const key = `evaluation:${fingerprint({ model: JEV_MODEL, request })}`;
  const previous = await findConsolidationRecord<Evaluation>(ownerId, key);
  if (previous) return previous;
  const evaluation = await evaluateJev(request);
  try {
    await saveConsolidationRecord(ownerId, runId, key, evaluation);
  } catch (error) {
    if (error instanceof BrainError && error.code === "RECORD_CONFLICT") {
      const committed = await readConsolidationRecord<Evaluation>(
        ownerId,
        runId,
        key,
      );
      if (committed) return committed;
    }
    throw error;
  }
  return evaluation;
}

export async function analyzeConsolidationTask(
  ownerId: string,
  runId: string,
  snapshotId: string,
  task: AnalysisTask,
) {
  "use step";
  try {
    const snapshot = await loadSnapshot(ownerId, runId, snapshotId);
    const result = await analyzeTask(snapshot, task, (request) =>
      evaluatePersisted(ownerId, runId, request),
    );
    if (result.status === "complete")
      await saveConsolidationRecord(
        ownerId,
        runId,
        `analysis:${task.id}`,
        result,
      );
    else
      await saveConsolidationRecord(
        ownerId,
        runId,
        `incomplete-analysis:${task.id}`,
        result,
      );
    // Full judgments remain in immutable audit storage. Replaying Workflow only
    // needs findings/status, not copies of every model input for every task.
    return { ...result, judgments: [] };
  } catch (error) {
    return failProvider(error);
  }
}

function terminalDecision(decision: DecisionRecord | null) {
  return (
    decision && ["rejected", "uncertain", "no_change"].includes(decision.status)
  );
}

export async function planConsolidation(
  ownerId: string,
  runId: string,
  snapshotId: string,
  results: AnalysisResult[],
) {
  "use step";
  const snapshot = await loadSnapshot(ownerId, runId, snapshotId);
  const plans = planOperations(snapshot, results);
  const remaining: OperationPlan[] = [];
  const decisions = await findConsolidationRecords<DecisionRecord>(
    ownerId,
    plans.map((plan) => `decision:${plan.id}`),
    ["changeSet", "verification"],
  );
  for (const plan of plans) {
    if (!terminalDecision(decisions.get(`decision:${plan.id}`) ?? null))
      remaining.push(plan);
  }
  const selected = selectIndependentPlans(remaining);
  return { selected: selected.selected, deferred: selected.deferred.length };
}

function scopedSnapshot(snapshot: Snapshot, plan: OperationPlan): Snapshot {
  const ids = new Set(plan.readSet.map((ref) => ref.pageId));
  return {
    ...snapshot,
    pages: snapshot.pages.filter((page) => ids.has(page.id)),
    units: snapshot.units.filter((unit) => ids.has(unit.pageId)),
  };
}

export async function draftConsolidation(
  ownerId: string,
  runId: string,
  snapshotId: string,
  plan: OperationPlan,
  attempt: number,
  feedback?: string[],
) {
  "use step";
  const key = `draft:${fingerprint({ plan, attempt, feedback: feedback ?? [] })}`;
  const previous = await readConsolidationRecord<Draft>(ownerId, runId, key);
  if (previous) return previous;
  try {
    const snapshot = await loadSnapshot(ownerId, runId, snapshotId);
    const draft = await draftChanges(
      scopedSnapshot(snapshot, plan),
      plan,
      feedback,
    );
    await saveConsolidationRecord(ownerId, runId, key, draft);
    return draft;
  } catch (error) {
    return failProvider(error);
  }
}

export async function reviewConsolidation(
  ownerId: string,
  runId: string,
  snapshotId: string,
  plan: OperationPlan,
  draft: Draft,
) {
  "use step";
  const snapshot = await loadSnapshot(ownerId, runId, snapshotId);
  const scope = scopedSnapshot(snapshot, plan);
  let changeSet: ChangeSet;
  try {
    changeSet = materializeDraft(scope, plan, draft);
  } catch {
    return {
      changeSet: null,
      verification: {
        status: "rejected",
        defects: [
          "Invalid or out-of-scope patch; use exact target unit text and preserve original metadata and sources.",
        ],
        judgments: [],
      } satisfies Verification,
    };
  }
  try {
    const verification = await verifyChangeSet(scope, changeSet, (request) =>
      evaluatePersisted(ownerId, runId, request),
    );
    await saveConsolidationRecord(
      ownerId,
      runId,
      `verification:${fingerprint({ changeSet, policy: POLICY.version })}`,
      verification,
    );
    return { changeSet, verification: { ...verification, judgments: [] } };
  } catch (error) {
    return failProvider(error);
  }
}

export async function expandConsolidation(
  ownerId: string,
  runId: string,
  snapshotId: string,
  plan: OperationPlan,
  depth: number,
): Promise<OperationPlan | null> {
  "use step";
  const snapshot = await loadSnapshot(ownerId, runId, snapshotId);
  const read = new Set(plan.readSet.map((ref) => ref.pageId));
  const additional =
    depth === 1
      ? snapshot.pages
          .filter((page) => read.has(page.id))
          .flatMap((page) => [
            ...page.links.map((link) => link.targetId),
            ...page.backlinks.map((link) => link.sourceId),
          ])
      : snapshot.pages.map((page) => page.id);
  for (const id of additional) read.add(id);
  if (read.size === plan.readSet.length) return null;
  const pages = snapshot.pages.filter((page) => read.has(page.id));
  if (JSON.stringify(pages).length > POLICY.evaluationCharacters) return null;
  return {
    ...plan,
    readSet: pages.map((page) => ({ pageId: page.id, version: page.version })),
    evidenceUnitIds: snapshot.units
      .filter((unit) => read.has(unit.pageId))
      .map((unit) => unit.id),
  };
}

export async function applyConsolidation(
  ownerId: string,
  runId: string,
  changeSet: ChangeSet,
) {
  "use step";
  const result = await applyConsolidationChangeSet(
    ownerId,
    changeSet,
    `consolidation:${runId}:${changeSet.id}`,
  );
  if (result.status !== "conflict") revalidateWorkspaceCache(ownerId);
  return result;
}

export async function recordConsolidation(
  ownerId: string,
  runId: string,
  key: string,
  value: unknown,
) {
  "use step";
  await saveConsolidationRecord(ownerId, runId, key, value);
}

export async function finishConsolidation(
  ownerId: string,
  runId: string,
  summary: unknown,
) {
  "use step";
  await finishConsolidationRun(ownerId, runId, summary);
}
