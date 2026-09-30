import { FatalError, RetryableError } from "workflow";
import { BrainError } from "../../brain/types";
import { revalidateWorkspaceCache } from "../../workspace/cache";
import { GatewayRequestError } from "../gateway";
import { analyzeTask } from "./analysis";
import { BudgetExhaustedError, budgetedGateway } from "./budget";
import { canReuseAnalysis, canReuseDecision } from "./cache";
import { CapacityError, capacityVerification } from "./capacity";
import {
  EditorResponseError,
  failureDiagnostic,
  failureMessage,
} from "./diagnostics";
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
  readConsolidationQueue,
  readConsolidationRecord,
  saveConsolidationQueue,
  saveConsolidationRecord,
} from "./store";
import {
  type AnalysisResult,
  type AnalysisTask,
  type ChangeSet,
  type DecisionRecord,
  type Draft,
  type DraftOutcome,
  type Evaluation,
  type EvaluationRequest,
  type OperationPlan,
  POLICY,
  type RunHalt,
  type Snapshot,
  type Verification,
} from "./types";
import { verifyChangeSet } from "./verifier";

function haltFor(error: unknown): RunHalt | null {
  if (error instanceof BudgetExhaustedError) return { halt: "budget" };
  if (error instanceof GatewayRequestError && error.status === 402)
    return { halt: "provider" };
  return null;
}

function failProvider(error: unknown): never {
  if (error instanceof FatalError || error instanceof RetryableError)
    throw error;
  const diagnostic = failureDiagnostic(error);
  console.error("consolidation.step_error", {
    ...diagnostic,
    ...(error instanceof EditorResponseError
      ? { usage: error.usage, generationId: error.generationId }
      : {}),
    frames:
      error instanceof Error
        ? error.stack
            ?.split("\n")
            .filter((line) => /^\s+at /.test(line))
            .slice(0, 8)
        : undefined,
  });
  const message = failureMessage(diagnostic);
  if (diagnostic.retryable)
    throw new RetryableError(message, {
      retryAfter:
        error instanceof GatewayRequestError
          ? (error.retryAfterMs ?? 10_000)
          : 10_000,
    });
  throw new FatalError(message);
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
    taskBudget: integerSetting(
      "CONSOLIDATION_TASK_BUDGET",
      POLICY.tasksPerRun,
      1_000_000,
    ),
    repairs: POLICY.draftRepairs,
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
  let reused = 0;
  for (const task of tasks) {
    const result = records.get(`analysis:${task.id}`);
    if (result && canReuseAnalysis(snapshot, result)) {
      reused++;
      if (!result.findings.some((finding) => finding.status === "supported"))
        continue;
      cached.push({ ...result, judgments: [] });
    }
    pending.push(task);
  }
  const cachedPlans = new Map(
    cached.map((result) => [result.taskId, planOperations(snapshot, [result])]),
  );
  const decisions = await findConsolidationRecords<DecisionRecord>(
    ownerId,
    [...cachedPlans.values()].flatMap((plans) =>
      plans.map((plan) => `decision:${plan.id}`),
    ),
    ["changeSet", "verification"],
  );
  const completed = new Set(
    [...cachedPlans]
      .filter(([, plans]) =>
        plans.every((plan) =>
          canReuseDecision(snapshot, decisions.get(`decision:${plan.id}`)),
        ),
      )
      .map(([id]) => id),
  );
  const outstanding = pending.filter((task) => !completed.has(task.id));
  const prior = await readConsolidationQueue(ownerId);
  const byId = new Map(outstanding.map((task) => [task.id, task]));
  const order = [
    ...new Set([...prior, ...outstanding.map((task) => task.id)]),
  ].filter((id) => byId.has(id));
  // Store outstanding work once; only the bounded scheduled subset crosses the step boundary.
  await saveConsolidationQueue(ownerId, order);
  const selected = order
    .slice(0, budget)
    .map((id) => byId.get(id))
    .filter((task): task is AnalysisTask => task !== undefined);
  const selectedIds = new Set(selected.map((task) => task.id));
  return {
    tasks: selected,
    cached: cached.filter((result) => selectedIds.has(result.taskId)),
    reused,
    total: tasks.length,
    remaining: outstanding.length - selected.length,
  };
}

async function evaluatePersisted(
  ownerId: string,
  runId: string,
  request: EvaluationRequest,
): Promise<Evaluation> {
  const key = `evaluation:${fingerprint({ model: JEV_MODEL, request })}`;
  let stage = "evaluation_cache";
  try {
    const previous = await findConsolidationRecord<Evaluation>(ownerId, key);
    if (previous) return previous;
    stage = "evaluation_provider";
    const evaluation = await evaluateJev(
      request,
      budgetedGateway(ownerId, runId),
    );
    stage = "evaluation_save";
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
  } catch (error) {
    if (error instanceof BudgetExhaustedError) throw error;
    console.error("consolidation.evaluation_error", {
      runId,
      requestKey: key,
      stage,
      ...failureDiagnostic(error),
    });
    throw error;
  }
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
        `incomplete-analysis:${task.id}:${snapshot.id}`,
        result,
      );
    // Full judgments remain in immutable audit storage. Replaying Workflow only
    // needs findings/status, not copies of every model input for every task.
    return { ...result, judgments: [] };
  } catch (error) {
    return haltFor(error) ?? failProvider(error);
  }
}

export async function planConsolidation(
  ownerId: string,
  runId: string,
  snapshotId: string,
  results: AnalysisResult[],
) {
  "use step";
  try {
    const snapshot = await loadSnapshot(ownerId, runId, snapshotId);
    const plans = planOperations(snapshot, results);
    const remaining: OperationPlan[] = [];
    let capacityLimited = 0;
    const decisions = await findConsolidationRecords<DecisionRecord>(
      ownerId,
      plans.map((plan) => `decision:${plan.id}`),
      ["changeSet", "verification"],
    );
    for (const plan of plans) {
      const decision = decisions.get(`decision:${plan.id}`);
      if (!canReuseDecision(snapshot, decision)) remaining.push(plan);
      else if (decision?.reason === "capacity") capacityLimited++;
    }
    const selected = selectIndependentPlans(remaining);
    return {
      selected: selected.selected,
      deferred: selected.deferred.length,
      capacityLimited,
    };
  } catch (error) {
    failProvider(error);
  }
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
): Promise<DraftOutcome> {
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
      budgetedGateway(ownerId, runId),
    );
    await saveConsolidationRecord(ownerId, runId, key, draft);
    return draft;
  } catch (error) {
    if (error instanceof CapacityError) return { capacity: error.capacity };
    return haltFor(error) ?? failProvider(error);
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
  } catch (error) {
    if (error instanceof CapacityError)
      return {
        changeSet: null,
        verification: capacityVerification(error.capacity),
      };
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
    return haltFor(error) ?? failProvider(error);
  }
}

export async function applyConsolidation(
  ownerId: string,
  runId: string,
  changeSet: ChangeSet,
) {
  "use step";
  try {
    const result = await applyConsolidationChangeSet(
      ownerId,
      changeSet,
      `consolidation:${runId}:${changeSet.id}`,
    );
    if (result.status !== "conflict") revalidateWorkspaceCache(ownerId);
    return result;
  } catch (error) {
    failProvider(error);
  }
}

export async function recordConsolidation(
  ownerId: string,
  runId: string,
  key: string,
  value: unknown,
) {
  "use step";
  if (key.startsWith("task-error:"))
    console.error("consolidation.task_error", { runId, key, failure: value });
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

export async function queueConsolidation(
  ownerId: string,
  completedTaskIds: string[],
) {
  "use step";
  const completed = new Set(completedTaskIds);
  const pending = await readConsolidationQueue(ownerId);
  await saveConsolidationQueue(
    ownerId,
    pending.filter((id) => !completed.has(id)),
  );
}
