import { timingSafeEqual } from "node:crypto";
import { BrainError } from "@/lib/brain/types";
import { assertOwner } from "@/lib/brain/utils";
import { getPool, transaction } from "@/lib/db";

export function isCronRequest(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const supplied = Buffer.from(request.headers.get("authorization") || "");
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}

export async function enqueueNightly(ownerId: string) {
  assertOwner(ownerId);
  const { rows } = await getPool().query(
    `INSERT INTO brain_jobs (owner_id, kind)
     VALUES ($1, 'consolidation'), ($1, 'export')
     ON CONFLICT (owner_id, kind, run_date) DO NOTHING RETURNING id, kind`,
    [ownerId],
  );
  return rows;
}

export async function claimJob(
  ownerId: string,
  kind: "consolidation" | "export",
) {
  assertOwner(ownerId);
  return transaction(async (client) => {
    await client.query(
      `UPDATE brain_jobs SET status='failed',finished_at=now(),lease_until=NULL,
        error='Retry budget exhausted after the final worker lease expired.'
       WHERE owner_id=$1 AND kind=$2 AND status='running' AND lease_until<now() AND attempts>=4`,
      [ownerId, kind],
    );
    const { rows } = await client.query(
      `WITH candidate AS (
        SELECT id FROM brain_jobs WHERE owner_id = $1 AND kind = $2 AND attempts < 4
        AND (status IN ('queued','failed') OR (status = 'running' AND lease_until < now()))
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE brain_jobs j SET status = 'running', attempts = attempts + 1,
        lease_id = gen_random_uuid(), lease_until = now() + interval '25 minutes',
        started_at = now(), finished_at = NULL, error = NULL
      FROM candidate c WHERE j.id = c.id
      RETURNING j.id, j.kind, j.lease_id AS "leaseId", j.run_date::text AS "runDate"`,
      [ownerId, kind],
    );
    return rows[0] ?? null;
  });
}

export async function finishJob(
  ownerId: string,
  input: {
    id: string;
    leaseId: string;
    status: "succeeded" | "failed";
    result?: Record<string, unknown>;
    error?: string;
  },
) {
  assertOwner(ownerId);
  return transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT kind FROM brain_jobs WHERE owner_id=$1 AND id=$2 AND lease_id=$3
        AND status='running' AND lease_until>now() FOR UPDATE`,
      [ownerId, input.id, input.leaseId],
    );
    if (!rows[0])
      throw new BrainError(
        "LEASE_EXPIRED",
        "This job lease is expired or already completed.",
        409,
      );
    if (
      rows[0].kind === "export" &&
      input.status === "succeeded" &&
      (input.result?.pushed !== true ||
        typeof input.result?.commit !== "string" ||
        !/^[a-f0-9]{40,64}$/.test(input.result.commit))
    ) {
      throw new BrainError(
        "EXPORT_NOT_PERSISTED",
        "A Git export can succeed only after its commit has been pushed and read back from the remote.",
        400,
      );
    }
    await client.query(
      `UPDATE brain_jobs SET status = $4, result = $5::jsonb, error = $6,
      finished_at = now(), lease_until = NULL
     WHERE owner_id = $1 AND id = $2 AND lease_id = $3 AND status = 'running' AND lease_until > now()`,
      [
        ownerId,
        input.id,
        input.leaseId,
        input.status,
        JSON.stringify(input.result ?? {}),
        input.error?.slice(0, 2000) ?? null,
      ],
    );
    return { ok: true };
  });
}

export async function operationsStatus(ownerId: string) {
  assertOwner(ownerId);
  const { rows: jobs } = await getPool().query(
    `SELECT id, kind, status, started_at AS "startedAt", finished_at AS "finishedAt", error,
      run_date::text AS "runDate", attempts, result FROM brain_jobs WHERE owner_id = $1
     ORDER BY created_at DESC LIMIT 20`,
    [ownerId],
  );
  const checks = [
    {
      name: "Postgres",
      status: "ready",
      detail:
        "Connected. Markdown, links and revisions are stored in your database.",
    },
    {
      name: "Nightly schedule",
      status: process.env.CRON_SECRET ? "ready" : "missing",
      detail: "Vercel Cron queues nightly work at 02:00 UTC.",
    },
    {
      name: "Agent runner",
      status: process.env.BRAIN_RUNNER_REPOSITORY ? "ready" : "missing",
      detail: process.env.BRAIN_RUNNER_REPOSITORY
        ? `Runner: ${process.env.BRAIN_RUNNER_REPOSITORY}. Recent job results appear below.`
        : "Configure the separate nightly runner. The application never calls a model.",
    },
    {
      name: "Consolidation model",
      status: "ready",
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
