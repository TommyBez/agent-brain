import { BrainError } from "../brain/types";
import { assertOwner } from "../brain/utils";
import { getPool, transaction } from "../db";

export const WORKFLOW_JOB_KINDS = [
  "consolidation",
  "embeddings",
  "export",
] as const;
export type WorkflowJobKind = (typeof WORKFLOW_JOB_KINDS)[number];
export type WorkflowJobCompletion = "succeeded" | "partial" | "failed";
export type WorkflowJobStatus = "queued" | "running" | WorkflowJobCompletion;

export interface WorkflowJob {
  id: string;
  executor: "workflow";
  kind: WorkflowJobKind;
  runDate: string;
  status: WorkflowJobStatus;
  workflowRunId: string | null;
  attempts: number;
  result: Record<string, unknown> | null;
  error: string | null;
}

const JOB_COLUMNS = `id, executor, kind, run_date::text AS "runDate", status,
  workflow_run_id AS "workflowRunId", attempts, result, error`;

function validateRunDate(runDate: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(runDate) ||
    !Number.isFinite(Date.parse(`${runDate}T00:00:00Z`)) ||
    new Date(`${runDate}T00:00:00Z`).toISOString().slice(0, 10) !== runDate ||
    runDate.startsWith("0000")
  )
    throw new BrainError(
      "INVALID_RUN_DATE",
      "A valid YYYY-MM-DD run date is required.",
    );
}

function validateWorkflowRunId(workflowRunId: string) {
  if (
    typeof workflowRunId !== "string" ||
    workflowRunId.length > 256 ||
    workflowRunId.trim().length === 0
  )
    throw new BrainError(
      "INVALID_WORKFLOW_RUN",
      "A Workflow run ID of 1–256 characters is required.",
    );
}

/** Show all stages as queued before the asynchronously started workflow wakes. */
export async function queueWorkflowJobs(ownerId: string, runDate: string) {
  assertOwner(ownerId);
  validateRunDate(runDate);
  await getPool().query(
    `INSERT INTO brain_jobs (owner_id,kind,run_date,executor)
     SELECT $1,kind,$2::date,'workflow' FROM unnest($3::text[]) AS kind
     ON CONFLICT (owner_id,kind,run_date,executor) DO NOTHING`,
    [ownerId, runDate, WORKFLOW_JOB_KINDS],
  );
}

/** The caller holds the owner's Workflow lock while executing this daily pass. */
export async function beginWorkflowJob(
  ownerId: string,
  kind: WorkflowJobKind,
  runDate: string,
  workflowRunId: string,
): Promise<WorkflowJob & { skip: boolean }> {
  assertOwner(ownerId);
  validateRunDate(runDate);
  validateWorkflowRunId(workflowRunId);
  if (!WORKFLOW_JOB_KINDS.includes(kind))
    throw new BrainError(
      "INVALID_JOB_KIND",
      "Unknown nightly Workflow job kind.",
    );
  return transaction(async (db) => {
    await db.query(
      `INSERT INTO brain_jobs (owner_id,kind,run_date,executor) VALUES ($1,$2,$3::date,'workflow')
       ON CONFLICT (owner_id,kind,run_date,executor) DO NOTHING`,
      [ownerId, kind, runDate],
    );
    const { rows } = await db.query<WorkflowJob>(
      `SELECT ${JOB_COLUMNS} FROM brain_jobs
       WHERE owner_id=$1 AND kind=$2 AND run_date=$3::date AND executor='workflow' FOR UPDATE`,
      [ownerId, kind, runDate],
    );
    const current = rows[0];
    if (current.status === "succeeded" || current.status === "partial")
      return { ...current, skip: true };
    if (current.status === "running" && current.workflowRunId === workflowRunId)
      return { ...current, skip: false };
    // A new owner-locked run can recover an interrupted or failed pass. Old
    // runner lease fields remain for history but have no role in Workflow.
    const updated = await db.query<WorkflowJob>(
      `UPDATE brain_jobs SET status='running',workflow_run_id=$3,attempts=attempts+1,
        started_at=now(),finished_at=NULL,error=NULL,result=NULL,lease_id=NULL,lease_until=NULL
       WHERE owner_id=$1 AND id=$2 AND executor='workflow' RETURNING ${JOB_COLUMNS}`,
      [ownerId, current.id, workflowRunId],
    );
    return { ...updated.rows[0], skip: false };
  });
}

export async function finishWorkflowJob(
  ownerId: string,
  id: string,
  workflowRunId: string,
  status: WorkflowJobCompletion,
  result?: Record<string, unknown>,
  error?: string,
): Promise<WorkflowJob> {
  assertOwner(ownerId);
  validateWorkflowRunId(workflowRunId);
  if (!["succeeded", "partial", "failed"].includes(status))
    throw new BrainError(
      "INVALID_JOB_STATUS",
      "Unknown nightly Workflow completion status.",
    );
  return transaction(async (db) => {
    const { rows } = await db.query<WorkflowJob>(
      `SELECT ${JOB_COLUMNS} FROM brain_jobs WHERE owner_id=$1 AND id=$2 AND executor='workflow' FOR UPDATE`,
      [ownerId, id],
    );
    const current = rows[0];
    if (!current || current.workflowRunId !== workflowRunId)
      throw new BrainError(
        "WORKFLOW_RUN_SUPERSEDED",
        "This job belongs to a different Workflow run or owner.",
        409,
      );
    // A durable step may retry after its original finish transaction committed.
    // Return the first completion unchanged, even if a retry supplies new data.
    if (current.status === status) return current;
    if (current.status !== "running")
      throw new BrainError(
        "WORKFLOW_JOB_FINISHED",
        "The job has already finished with a different status.",
        409,
      );
    if (
      current.kind === "export" &&
      status === "succeeded" &&
      (result?.pushed !== true ||
        typeof result.commit !== "string" ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result.commit))
    )
      throw new BrainError(
        "EXPORT_NOT_PERSISTED",
        "A Git export can succeed only after its commit has been pushed and read back from the remote.",
      );
    const updated = await db.query<WorkflowJob>(
      `UPDATE brain_jobs SET status=$4,result=$5::jsonb,error=$6,finished_at=now(),lease_until=NULL
       WHERE owner_id=$1 AND id=$2 AND workflow_run_id=$3 AND executor='workflow' RETURNING ${JOB_COLUMNS}`,
      [
        ownerId,
        id,
        workflowRunId,
        status,
        JSON.stringify(result ?? {}),
        error?.slice(0, 2000) ?? null,
      ],
    );
    return updated.rows[0];
  });
}

export async function dailyWorkflowStatus(
  ownerId: string,
  runDate: string,
): Promise<WorkflowJob[]> {
  assertOwner(ownerId);
  validateRunDate(runDate);
  const { rows } = await getPool().query<WorkflowJob>(
    `SELECT ${JOB_COLUMNS} FROM brain_jobs WHERE owner_id=$1 AND run_date=$2::date AND executor='workflow'
     ORDER BY kind`,
    [ownerId, runDate],
  );
  return rows;
}
