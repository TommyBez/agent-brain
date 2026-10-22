import { z } from "zod";
import { embeddingSchema } from "../../brain/schemas";
import { embeddingModel, vectorLiteral } from "../../brain/utils";
import { getPool, transaction } from "../../db";
import { systemActor } from "../../tasks/actors";
import {
  type LinkChange,
  lockTaskForLinks,
  refreshTaskRules,
} from "../../tasks/links";
import {
  corpusFingerprint,
  nightlyTaskRetrieval,
  taskEmbeddingText,
  taskSemanticFingerprint,
} from "../../tasks/retrieval";
import { OPEN_TASK_STATUSES } from "../../tasks/types";
import { budgetedGateway, recordedSpendNano } from "../consolidator/budget";
import { type GatewayCall, gatewayRequest } from "../gateway";
import { TRIAGE_ENTERED } from "../task-keeper/hygiene";
import type { TaskPhaseHalt } from "../task-phase";
import { taskPhaseHalt } from "../task-phase-halt";
import { jevQueue, linkInputsFingerprint } from "./candidates";
import { type AutoApplyState, autoApplyGates, autoApplyState } from "./gate";
import { TASK_LINK_POLICY } from "./policy";
import { JEV_LINK_STATUSES, linkTask } from "./run";
import { loadLinkInputs, loadTaskVector } from "./store";

// The nightly task_links pass, step-side (§8.1 "di notte", §8.3). The
// Workflow orchestration in index.ts calls these through "use step" adapters.

export const TASK_VECTOR_BATCH = 32;

export interface TaskLinksPlan {
  corpus: string;
  /** Open tasks in queue order (triage included): rules and retrieval. */
  openTaskIds: string[];
  /** Tasks whose stored vector is missing or older than their content. */
  vectorTaskIds: string[];
  /**
   * Non-triage open tasks for Jev, at most maxTasksPerRun: those whose inputs
   * changed since their last completed pass first (least recently completed
   * when they do not fit), then the others.
   */
  jevTaskIds: string[];
  /** Tasks with changed inputs beyond maxTasksPerRun, first in the next run. */
  remainingTasks: number;
  autoApply: AutoApplyState;
  /** Why each role is not applied automatically (all of them, at release). */
  autoApplyReasons: Record<string, string[]>;
}

export async function planTaskLinks(ownerId: string): Promise<TaskLinksPlan> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT id, status, title, description, acceptance_criteria, project_page_id,
       semantic_fingerprint, embedding_model, embedding IS NOT NULL AS embedded
     FROM brain_tasks
     WHERE owner_id = $1 AND archived_at IS NULL AND status = ANY($2::text[])
     ORDER BY priority, COALESCE(due_on, (due_at AT TIME ZONE 'Europe/Rome')::date) NULLS LAST, number`,
    [ownerId, OPEN_TASK_STATUSES],
  );
  const model = embeddingModel();
  const semantic = new Map<string, string>(
    rows.map((row) => [
      row.id,
      taskSemanticFingerprint({
        title: row.title,
        description: row.description,
        acceptanceCriteria: row.acceptance_criteria,
        projectPageId: row.project_page_id,
      }),
    ]),
  );
  const vectorTaskIds = rows
    .filter(
      (row) =>
        !row.embedded ||
        row.embedding_model !== model ||
        row.semantic_fingerprint !== semantic.get(row.id),
    )
    .map((row) => row.id as string);
  const corpus = await corpusFingerprint(db, ownerId);
  const policyVersion = TASK_LINK_POLICY.version;
  // Vectors of changed tasks are embedded before the Jev pass.
  const linkable = rows
    .filter((row) =>
      (JEV_LINK_STATUSES as readonly string[]).includes(row.status),
    )
    .map((row) => ({
      id: row.id as string,
      inputs: linkInputsFingerprint({
        policyVersion,
        taskFingerprint: semantic.get(row.id) as string,
        corpus,
        vectorModel: model,
      }),
    }));
  const queue = jevQueue(
    linkable,
    await loadLinkInputs(
      db,
      ownerId,
      linkable.map((task) => task.id),
    ),
  );
  const gates = await autoApplyGates(db, ownerId);
  return {
    corpus,
    openTaskIds: rows.map((row) => row.id as string),
    vectorTaskIds,
    jevTaskIds: queue.taskIds,
    remainingTasks: queue.remainingTasks,
    autoApply: autoApplyState(gates),
    autoApplyReasons: Object.fromEntries(
      gates.map((gate) => [gate.role, gate.reasons]),
    ),
  };
}

const embeddingResponse = z.object({
  data: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      embedding: embeddingSchema,
    }),
  ),
});

/** Task vectors through the maintenance gateway, like page embeddings (never the query key). */
export async function embedTaskVectors(
  ownerId: string,
  taskIds: string[],
  send: GatewayCall = gatewayRequest,
): Promise<{ embedded: number; halt: TaskPhaseHalt | null }> {
  if (!taskIds.length) return { embedded: 0, halt: null };
  const { rows } = await getPool().query(
    `SELECT id, title, description, acceptance_criteria, project_page_id
     FROM brain_tasks WHERE owner_id = $1 AND id = ANY($2::uuid[]) AND archived_at IS NULL`,
    [ownerId, taskIds],
  );
  if (!rows.length) return { embedded: 0, halt: null };
  const tasks = rows.map((row) => ({
    id: row.id as string,
    content: {
      title: row.title as string,
      description: row.description as string,
      acceptanceCriteria: row.acceptance_criteria as string[],
      projectPageId: row.project_page_id as string | null,
    },
  }));
  const model = embeddingModel();
  let vectors: number[][];
  try {
    const response = embeddingResponse.parse(
      await send("embeddings", {
        model,
        input: tasks.map((task) => taskEmbeddingText(task.content)),
        dimensions: 1536,
      }),
    );
    if (response.data.length !== tasks.length)
      throw new Error("Embedding count mismatch");
    vectors = tasks.map((_, index) => {
      const item = response.data.find((entry) => entry.index === index);
      if (!item) throw new Error("Embedding index mismatch");
      return item.embedding;
    });
  } catch (error) {
    console.error("task_links.embedding_error", {
      tasks: tasks.length,
      error: error instanceof Error ? error.name : "unknown error",
    });
    return { embedded: 0, halt: "embeddings" };
  }
  let embedded = 0;
  for (const [index, task] of tasks.entries()) {
    // Compare-and-swap on the embedded content; never bumps version or updated_at.
    const { rowCount } = await getPool().query(
      `UPDATE brain_tasks SET semantic_fingerprint = $3, embedding = $4::vector, embedding_model = $5
       WHERE owner_id = $1 AND id = $2 AND title = $6 AND description = $7
         AND acceptance_criteria = $8::text[] AND project_page_id IS NOT DISTINCT FROM $9::uuid`,
      [
        ownerId,
        task.id,
        taskSemanticFingerprint(task.content),
        vectorLiteral(vectors[index]),
        model,
        task.content.title,
        task.content.description,
        task.content.acceptanceCriteria,
        task.content.projectPageId,
      ],
    );
    embedded += rowCount ?? 0;
  }
  return { embedded, halt: null };
}

export interface DeterministicResult {
  rules: { suggested: number; activated: number; retracted: number };
  retrieval: {
    searched: number;
    suggested: number;
    retracted: number;
  };
}

function count(changes: LinkChange[], status: string) {
  return changes.filter(
    (change) => change.status === status && change.previous !== status,
  ).length;
}

/** Rules for every open task, then retrieval for tasks with fresh vectors or a changed corpus. */
export async function refreshDeterministicLinks(
  ownerId: string,
  runId: string,
  taskIds: string[],
  corpus: string,
): Promise<DeterministicResult> {
  const result: DeterministicResult = {
    rules: { suggested: 0, activated: 0, retracted: 0 },
    retrieval: { searched: 0, suggested: 0, retracted: 0 },
  };
  if (!taskIds.length) return result;
  const conciliator = await systemActor(ownerId, "consolidator");
  for (const taskId of taskIds) {
    const rules = await transaction(async (db) => {
      const task = await lockTaskForLinks(db, ownerId, taskId);
      return task
        ? refreshTaskRules(db, ownerId, task, conciliator.agentId)
        : [];
    });
    result.rules.suggested += count(rules, "suggested");
    result.rules.activated += count(rules, "active");
    result.rules.retracted += count(rules, "retracted");
    const stored = await loadTaskVector(getPool(), ownerId, taskId);
    const retrieval = await nightlyTaskRetrieval(
      ownerId,
      runId,
      taskId,
      conciliator.agentId,
      corpus,
      stored?.embeddingModel === embeddingModel() ? stored : null,
    );
    if (retrieval.searched) result.retrieval.searched++;
    result.retrieval.suggested += count(retrieval.changes, "suggested");
    result.retrieval.retracted += count(retrieval.changes, "retracted");
  }
  return result;
}

export interface JevBatchResult {
  tasksConsidered: number;
  unitsReused: number;
  requests: number;
  suggested: number;
  activated: number;
  retracted: number;
  deferred: number;
  /** Tasks of the batch not reached because the pass halted. */
  unprocessed: number;
  halt: TaskPhaseHalt | null;
}

/** The Jev pass for a batch; budget and provider errors end it as data. */
export async function linkTaskBatch(
  ownerId: string,
  runId: string,
  taskIds: string[],
  autoApply: AutoApplyState,
  corpus: string,
  gateway: GatewayCall = budgetedGateway(ownerId, runId, "task_links"),
): Promise<JevBatchResult> {
  const result: JevBatchResult = {
    tasksConsidered: 0,
    unitsReused: 0,
    requests: 0,
    suggested: 0,
    activated: 0,
    retracted: 0,
    deferred: 0,
    unprocessed: 0,
    halt: null,
  };
  if (!taskIds.length) return result;
  const conciliator = await systemActor(ownerId, "consolidator");
  for (const [index, taskId] of taskIds.entries()) {
    try {
      const linked = await linkTask(
        ownerId,
        runId,
        taskId,
        conciliator.agentId,
        gateway,
        autoApply,
        corpus,
      );
      if (linked.considered) result.tasksConsidered++;
      if (linked.reused) result.unitsReused++;
      if (linked.outcome === "deferred") result.deferred++;
      result.requests += linked.requests;
      result.suggested += linked.suggested;
      result.activated += linked.activated;
      result.retracted += linked.retracted;
    } catch (error) {
      const halt = taskPhaseHalt(error);
      if (!halt) throw error;
      result.halt = halt;
      result.unprocessed = taskIds.length - index;
      break;
    }
  }
  return result;
}

export interface TaskLinkHygiene {
  expiredLeases: number;
  overdue: number;
  triageAging: number;
  unansweredQuestions: number;
}

/** §8.1 step 4: counts only; the conciliator never transitions a task. */
export async function taskLinkHygiene(
  ownerId: string,
): Promise<TaskLinkHygiene> {
  const { rows } = await getPool().query(
    `SELECT
       count(*) FILTER (WHERE lease_id IS NOT NULL AND lease_expires_at < now())::int AS expired_leases,
       count(*) FILTER (WHERE status <> ALL(ARRAY['done','canceled'])
         AND COALESCE(due_on, (due_at AT TIME ZONE 'Europe/Rome')::date) < (now() AT TIME ZONE 'Europe/Rome')::date)::int AS overdue,
       count(*) FILTER (WHERE status = 'triage' AND ${TRIAGE_ENTERED} < now() - interval '7 days')::int AS triage_aging,
       count(*) FILTER (WHERE status = 'needs_input' AND input_requested_at < now() - interval '7 days')::int AS unanswered
     FROM brain_tasks t WHERE t.owner_id = $1 AND t.archived_at IS NULL`,
    [ownerId],
  );
  return {
    expiredLeases: rows[0].expired_leases,
    overdue: rows[0].overdue,
    triageAging: rows[0].triage_aging,
    unansweredQuestions: rows[0].unanswered,
  };
}

export async function taskLinkSpend(
  ownerId: string,
  runId: string,
): Promise<number> {
  return recordedSpendNano(ownerId, runId, ["task_links"]);
}
