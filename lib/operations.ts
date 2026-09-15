import { timingSafeEqual } from "node:crypto";
import { getRun } from "workflow/api";
import { queryEmbeddingsConfigured } from "@/lib/brain/embeddings";
import { assertOwner, embeddingModel } from "@/lib/brain/utils";
import { getPool, transaction } from "@/lib/db";

export type MaintenanceJob = {
  id: string;
  kind: string;
  status: string;
  runDate: string;
  workflowRunId: string | null;
  workflowStatus?: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  result: {
    report?: string;
    writes?: number;
    indexed?: number;
    indexedPages?: number;
    embeddedChunks?: number;
    remaining?: number;
    inputTokens?: number;
    outputTokens?: number;
    pages?: number;
    links?: number;
    budgetReached?: boolean;
    commit?: string;
    repository?: string;
  } | null;
};

export type OperationsData = Awaited<ReturnType<typeof operationsStatus>>;

export function isCronRequest(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const supplied = Buffer.from(request.headers.get("authorization") || "");
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}

export async function operationsStatus(ownerId: string) {
  assertOwner(ownerId);
  const { rows: jobs } = await getPool().query<MaintenanceJob>(
    `SELECT id, kind, status, started_at AS "startedAt", finished_at AS "finishedAt", error,
      run_date::text AS "runDate", executor, workflow_run_id AS "workflowRunId", attempts, result FROM brain_jobs WHERE owner_id = $1
     ORDER BY created_at DESC LIMIT 20`,
    [ownerId],
  );
  const runIds = [
    ...new Set<string>(
      jobs
        .map((job) => job.workflowRunId)
        .filter((runId): runId is string => Boolean(runId)),
    ),
  ];
  const runs = await Promise.all(
    runIds.map(async (runId) => {
      try {
        return { runId, status: await getRun(runId).status };
      } catch {
        return { runId, status: "unavailable" };
      }
    }),
  );
  for (const job of jobs) {
    const run = runs.find((run) => run.runId === job.workflowRunId);
    if (run) job.workflowStatus = run.status;
    // A cancelled/crashed engine may never reach the DB completion step. Present
    // its actual terminal state so the owner can retry instead of polling forever.
    if (
      job.status === "running" &&
      run &&
      ["failed", "cancelled", "completed"].includes(run.status)
    ) {
      job.status = "failed";
      job.error ||= `Workflow ${run.status} before this stage recorded completion. Run maintenance to retry.`;
    }
  }
  const checks = [
    {
      name: "Postgres",
      status: "ready",
      detail:
        "Connected. Markdown, links and revisions are stored in your database.",
    },
    {
      name: "Query embeddings",
      status: queryEmbeddingsConfigured() ? "ready" : "missing",
      detail: queryEmbeddingsConfigured()
        ? `Server-generated via AI Gateway (${embeddingModel()}). Text and graph remain available if the provider fails.`
        : "Server query embeddings are disabled or lack BRAIN_EMBEDDING_API_KEY. Retrieval uses text and graph.",
    },
    {
      name: "Nightly schedule",
      status: process.env.CRON_SECRET ? "ready" : "missing",
      detail: "Vercel Cron starts durable maintenance at 02:00 UTC.",
    },
    {
      name: "Vercel Workflow",
      status: process.env.AI_GATEWAY_API_KEY ? "ready" : "missing",
      detail: process.env.AI_GATEWAY_API_KEY
        ? "Durable consolidation and embedding steps. Completed steps survive interruptions; failed stages can be retried from Operations."
        : "Configure AI_GATEWAY_API_KEY for nightly consolidation and page embeddings.",
    },
    {
      name: "Git export",
      status: process.env.BRAIN_EXPORT_GITHUB_TOKEN ? "ready" : "missing",
      detail: `Daily commits to ${process.env.BRAIN_EXPORT_REPOSITORY || "TommyBez/agent-brain-memory"} through GitHub's API. No GitHub Actions runner or AI request is involved in exporting.`,
    },
    {
      name: "Consolidation model",
      status: process.env.AI_GATEWAY_API_KEY ? "ready" : "missing",
      detail: process.env.CONSOLIDATION_MODEL || "deepseek/deepseek-v4.1-flash",
    },
    {
      name: "Daily database snapshots",
      status: process.env.NEON_SNAPSHOT_SCHEDULE_VERIFIED_AT
        ? "ready"
        : "missing",
      detail: process.env.NEON_SNAPSHOT_SCHEDULE_VERIFIED_AT
        ? `Daily native snapshots with 7-day retention. Schedule verified ${process.env.NEON_SNAPSHOT_SCHEDULE_VERIFIED_AT}; check Neon for individual backup results.`
        : "Native snapshot schedule has not been verified. Git exports are not database backups.",
    },
  ];
  return {
    configured: checks.every((check) => check.status === "ready"),
    checks,
    jobs,
    runs,
  };
}

// Repeatable-read preserves a consistent graph and page set while agents continue writing.
export async function exportBrain(ownerId: string) {
  assertOwner(ownerId);
  return transaction(async (client) => {
    await client.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    );
    const { rows: pages } = await client.query(
      `SELECT id, slug, type, title, summary, markdown, aliases, tags, version,
        created_at AS "createdAt", updated_at AS "updatedAt" FROM brain_pages
       WHERE owner_id = $1 ORDER BY slug`,
      [ownerId],
    );
    const { rows: links } = await client.query(
      `SELECT l.id, l.source_id AS "sourceId", l.target_id AS "targetId", l.type, l.label,
        p.slug AS "sourceSlug", t.slug AS "targetSlug" FROM brain_links l
       JOIN brain_pages p ON p.id = l.source_id AND p.owner_id = l.owner_id
       JOIN brain_pages t ON t.id = l.target_id AND t.owner_id = l.owner_id
       WHERE l.owner_id = $1 ORDER BY l.source_id, l.target_id, l.type`,
      [ownerId],
    );
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      pages,
      links,
    };
  });
}
