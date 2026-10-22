import { timingSafeEqual } from "node:crypto";
import { getRun } from "workflow/api";
import { queryEmbeddingsConfigured } from "@/lib/brain/embeddings";
import { assertOwner, embeddingModel } from "@/lib/brain/utils";
import { getPool, transaction } from "@/lib/db";
import { exportRepositoryForEmail } from "@/lib/maintenance/export-repositories";
import type {
  WorkflowJobKind,
  WorkflowJobStatus,
} from "@/lib/maintenance/jobs";
import { tasksEnabledFor } from "@/lib/tasks/feature";

export type MaintenanceJob = {
  id: string;
  kind: WorkflowJobKind;
  status: WorkflowJobStatus;
  runDate: string;
  workflowRunId: string | null;
  workflowStatus?: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  result: {
    report?: string;
    writes?: number;
    indexedPages?: number;
    embeddedChunks?: number;
    remaining?: number;
    inputTokens?: number;
    outputTokens?: number;
    pages?: number;
    links?: number;
    tasks?: number;
    budgetReached?: boolean;
    commit?: string;
    repository?: string;
    skipped?: boolean;
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
      run_date::text AS "runDate", workflow_run_id AS "workflowRunId", attempts, result FROM brain_jobs WHERE owner_id = $1
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
  const { rows: owners } = await getPool().query<{ email: string }>(
    `SELECT email FROM "user" WHERE id = $1`,
    [ownerId],
  );
  const exportRepository = exportRepositoryForEmail(owners[0]?.email ?? "");
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
      status:
        !exportRepository || process.env.BRAIN_EXPORT_GITHUB_TOKEN
          ? "ready"
          : "missing",
      detail: exportRepository
        ? process.env.BRAIN_EXPORT_GITHUB_TOKEN
          ? `Daily commits to ${exportRepository} through GitHub's API. No GitHub Actions runner or AI request is involved in exporting.`
          : `This account exports to ${exportRepository}. Add BRAIN_EXPORT_GITHUB_TOKEN before nightly export can publish.`
        : "No repository is configured for this account, so nightly export is skipped.",
    },
    {
      name: "Consolidation models",
      status: process.env.AI_GATEWAY_API_KEY ? "ready" : "missing",
      detail: `Jev analysis and verification → deepseek/deepseek-v4.1-flash-1017 editing. Verified changes are applied automatically.`,
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

/** A closed task as exported in schemaVersion 2, separate from the pages. */
export interface ExportTask {
  id: string;
  number: number;
  ref: string;
  title: string;
  description: string;
  status: "done" | "canceled";
  priority: number;
  expectedOutput: string;
  reviewPolicy: string;
  requiresHuman: boolean;
  requiredCapability: string | null;
  due: {
    kind: string;
    on: string | null;
    at: string | null;
    text: string | null;
  };
  project: string | null;
  parent: string | null;
  origin: string;
  ownerQuote: string | null;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  delegate: string | null;
  acceptanceCriteria: string[];
  completion: {
    summary: string;
    criteria: unknown[];
    artifacts: unknown[];
    remaining: string | null;
    pagesChanged: unknown[];
    completedBy: string | null;
  } | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  version: number;
  links: {
    page: string;
    role: string;
    origin: string;
    confidence: number | null;
  }[];
  history: {
    events: number;
    byAction: Record<string, number>;
    timeline: {
      at: string;
      action: string;
      from: string | null;
      to: string | null;
      actor: string;
    }[];
  };
}

/** High-volume bookkeeping stays in the counts, out of the timeline. */
const UNTIMED_ACTIONS = new Set([
  "reported",
  "note",
  "edited",
  "links_changed",
]);
export const EXPORT_TIMELINE_LIMIT = 100;

const isoOrNull = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();

type ExportClient = Parameters<Parameters<typeof transaction>[0]>[0];

// Only done and canceled tasks: open work changes daily and is covered by
// Neon snapshots. A purged task is absent here, so it leaves the next export.
async function closedTasksForExport(
  client: ExportClient,
  ownerId: string,
): Promise<ExportTask[]> {
  const closed = "t.owner_id = $1 AND t.status IN ('done', 'canceled')";
  // One transaction client: run the reads in sequence.
  const { rows } = await client.query(
    `SELECT t.id, t.number, t.title, t.description, t.acceptance_criteria, t.expected_output,
         t.status, t.priority, t.due_kind, to_char(t.due_on, 'YYYY-MM-DD') AS due_on, t.due_at,
         t.due_text, t.requires_human, t.review_policy, t.required_capability, t.origin,
         t.owner_quote, t.completion, t.completed_at, t.created_at, t.updated_at, t.archived_at,
         t.approved_at, t.version, creator.label AS creator_label, delegate.label AS delegate_label,
         approver.label AS approver_label, project.slug AS project_slug, parent.number AS parent_number
       FROM brain_tasks t
       JOIN brain_agents creator ON creator.owner_id = t.owner_id AND creator.id = t.created_by_agent_id
       LEFT JOIN brain_agents delegate ON delegate.owner_id = t.owner_id AND delegate.id = t.delegate_agent_id
       LEFT JOIN brain_agents approver ON approver.owner_id = t.owner_id AND approver.id = t.approved_by_agent_id
       LEFT JOIN brain_pages project ON project.owner_id = t.owner_id AND project.id = t.project_page_id
       LEFT JOIN brain_tasks parent ON parent.owner_id = t.owner_id AND parent.id = t.parent_task_id
       WHERE ${closed} ORDER BY t.number`,
    [ownerId],
  );
  const links = await client.query(
    `SELECT l.task_id, p.slug, l.role, l.origin, l.confidence FROM brain_task_links l
       JOIN brain_tasks t ON t.owner_id = l.owner_id AND t.id = l.task_id
       JOIN brain_pages p ON p.owner_id = l.owner_id AND p.id = l.page_id
       WHERE ${closed} AND l.status = 'active' ORDER BY t.number, p.slug, l.role`,
    [ownerId],
  );
  const events = await client.query(
    `SELECT e.task_id, e.action, e.from_status, e.to_status, e.created_at, a.label AS actor
       FROM brain_task_events e
       JOIN brain_tasks t ON t.owner_id = e.owner_id AND t.id = e.task_id
       JOIN brain_agents a ON a.owner_id = e.owner_id AND a.id = e.actor_agent_id
       WHERE ${closed} ORDER BY t.number, e.id`,
    [ownerId],
  );
  const linksByTask = Map.groupBy(links.rows, (row) => row.task_id as string);
  const eventsByTask = Map.groupBy(events.rows, (row) => row.task_id as string);
  return rows.map((row): ExportTask => {
    const history = eventsByTask.get(row.id) ?? [];
    const byAction: Record<string, number> = {};
    for (const event of history)
      byAction[event.action] = (byAction[event.action] ?? 0) + 1;
    const completion = row.completion;
    return {
      id: row.id,
      number: row.number,
      ref: `T-${row.number}`,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      expectedOutput: row.expected_output,
      reviewPolicy: row.review_policy,
      requiresHuman: row.requires_human,
      requiredCapability: row.required_capability,
      due: {
        kind: row.due_kind,
        on: row.due_on,
        at: isoOrNull(row.due_at),
        text: row.due_text,
      },
      project: row.project_slug,
      parent: row.parent_number ? `T-${row.parent_number}` : null,
      origin: row.origin,
      ownerQuote: row.owner_quote,
      createdBy: row.creator_label,
      approvedBy: row.approver_label,
      approvedAt: isoOrNull(row.approved_at),
      delegate: row.delegate_label,
      acceptanceCriteria: row.acceptance_criteria,
      completion: completion
        ? {
            summary: completion.summary,
            criteria: completion.criteria ?? [],
            artifacts: completion.artifacts ?? [],
            remaining: completion.remaining ?? null,
            pagesChanged: completion.pagesChanged ?? [],
            completedBy: completion.completedByLabel ?? null,
          }
        : null,
      completedAt: isoOrNull(row.completed_at),
      createdAt: isoOrNull(row.created_at) as string,
      updatedAt: isoOrNull(row.updated_at) as string,
      archivedAt: isoOrNull(row.archived_at),
      version: row.version,
      links: (linksByTask.get(row.id) ?? []).map((link) => ({
        page: link.slug,
        role: link.role,
        origin: link.origin,
        confidence: link.confidence,
      })),
      history: {
        events: history.length,
        byAction,
        timeline: history
          .filter((event) => !UNTIMED_ACTIONS.has(event.action))
          .slice(-EXPORT_TIMELINE_LIMIT)
          .map((event) => ({
            at: isoOrNull(event.created_at) as string,
            action: event.action,
            from: event.from_status,
            to: event.to_status,
            actor: event.actor,
          })),
      },
    };
  });
}

// Repeatable-read preserves a consistent graph and page set while agents continue writing.
// When the owner has the task manager on, schemaVersion 2 adds the closed tasks
// in their own list; the switch is read in the same snapshot.
export async function exportBrain(ownerId: string) {
  assertOwner(ownerId);
  return transaction(async (client) => {
    await client.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    );
    const { rows: pages } = await client.query(
      `SELECT id, slug, type, title, summary, relationships, markdown, aliases, tags, version,
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
    const exportedAt = new Date().toISOString();
    if (!(await tasksEnabledFor(ownerId, client)))
      return { schemaVersion: 1 as const, exportedAt, pages, links };
    return {
      schemaVersion: 2 as const,
      exportedAt,
      pages,
      links,
      tasks: await closedTasksForExport(client, ownerId),
    };
  });
}
