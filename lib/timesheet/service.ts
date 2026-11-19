import { createHash } from "node:crypto";
import type { z } from "zod";
import type { Database } from "../brain/pages";
import { BrainError } from "../brain/types";
import { assertOwner } from "../brain/utils";
import { getPool, transaction } from "../db";
import type { Actor } from "../tasks/actors";
import { resolveProject } from "../tasks/page-links";
import {
  createTimeEntrySchema,
  deleteTimeEntrySchema,
  listTimeEntriesSchema,
  readTimeEntrySchema,
  type TimeEntry,
  updateTimeEntrySchema,
} from "./schemas";

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new BrainError(
    "INVALID_INPUT",
    parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; "),
    400,
    { issues: parsed.error.issues },
  );
}

const columns = `e.id, e.worked_on::text AS "workedOn", e.minutes, e.note,
  e.project_id AS "projectId", p.title AS "projectTitle", p.slug AS "projectSlug",
  e.version, e.deleted_at::text AS "deletedAt"`;
const join = `LEFT JOIN brain_pages p ON p.owner_id = e.owner_id AND p.id = e.project_id`;

async function readEntry(
  db: Database,
  ownerId: string,
  id: string,
): Promise<TimeEntry> {
  const { rows } = await db.query<TimeEntry>(
    `SELECT ${columns} FROM brain_time_entries e ${join} WHERE e.owner_id = $1 AND e.id = $2`,
    [ownerId, id],
  );
  if (!rows[0])
    throw new BrainError("TIME_ENTRY_NOT_FOUND", "Time entry not found.", 404);
  return rows[0];
}

export async function readTimeEntry(ownerId: string, input: unknown) {
  assertOwner(ownerId);
  return readEntry(getPool(), ownerId, parse(readTimeEntrySchema, input).id);
}

type TimeEntryFilters = z.output<typeof listTimeEntriesSchema>;

async function entryFilterParams(
  db: Database,
  ownerId: string,
  filters: Pick<TimeEntryFilters, "from" | "to" | "projectRef">,
) {
  let projectId: string | null = null;
  if (filters.projectRef) {
    // Historical associations remain filterable after a page changes type.
    const { rows } = await db.query<{ id: string }>(
      `SELECT p.id FROM brain_pages p WHERE p.owner_id = $1
       AND (p.id::text = $2 OR p.slug = $2)
       AND (p.type = 'project' OR EXISTS (
         SELECT 1 FROM brain_time_entries e WHERE e.owner_id = p.owner_id AND e.project_id = p.id
       ))`,
      [ownerId, filters.projectRef],
    );
    projectId =
      rows[0]?.id ?? (await resolveProject(db, ownerId, filters.projectRef)).id;
  }
  return [
    ownerId,
    filters.from ?? null,
    filters.to ?? null,
    filters.projectRef === undefined,
    projectId,
  ];
}

const entryFilter = `e.owner_id = $1 AND e.deleted_at IS NULL
  AND ($2::date IS NULL OR e.worked_on >= $2::date)
  AND ($3::date IS NULL OR e.worked_on <= $3::date)
  AND ($4::boolean OR e.project_id IS NOT DISTINCT FROM $5::uuid)`;

export async function listTimeEntries(ownerId: string, input: unknown) {
  assertOwner(ownerId);
  const filters = parse(listTimeEntriesSchema, input);
  const db = getPool();
  // One snapshot: totals cover the entire filtered set, including off-screen entries.
  const { rows } = await db.query<{
    entries: TimeEntry[];
    total: number;
    totalMinutes: number;
  }>(
    `
    WITH filtered AS (
      SELECT ${columns} FROM brain_time_entries e ${join}
      WHERE ${entryFilter}
    ), page AS (SELECT * FROM filtered ORDER BY "workedOn" DESC, id DESC LIMIT $6 OFFSET $7)
    SELECT COALESCE((SELECT jsonb_agg(page ORDER BY "workedOn" DESC, id DESC) FROM page), '[]'::jsonb) AS entries,
      count(*)::int AS total, COALESCE(sum(minutes), 0)::float8 AS "totalMinutes" FROM filtered
  `,
    [
      ...(await entryFilterParams(db, ownerId, filters)),
      filters.limit,
      filters.offset,
    ],
  );
  const result = rows[0];
  return {
    ...result,
    nextOffset:
      filters.offset + result.entries.length < result.total
        ? filters.offset + filters.limit
        : null,
  };
}

export type TimesheetDay = {
  workedOn: string;
  total: number;
  totalMinutes: number;
};

export async function listTimesheetMonth(
  ownerId: string,
  filters: TimeEntryFilters & { from: string; to: string; day: string },
) {
  assertOwner(ownerId);
  const db = getPool();
  // The grid and the selected day's entries read from the same snapshot.
  const { rows } = await db.query<{
    days: TimesheetDay[];
    entries: TimeEntry[];
  }>(
    `
    WITH filtered AS (
      SELECT e.id, e.worked_on, e.minutes
      FROM brain_time_entries e WHERE ${entryFilter}
    ), daily AS (
      SELECT worked_on::text AS "workedOn", count(*)::int AS total,
        sum(minutes)::float8 AS "totalMinutes"
      FROM filtered GROUP BY worked_on
    ), selected AS (
      SELECT id FROM filtered WHERE worked_on = $6::date ORDER BY id DESC LIMIT $7 OFFSET $8
    ), page AS (
      SELECT ${columns} FROM selected
      JOIN brain_time_entries e ON e.owner_id = $1 AND e.id = selected.id ${join}
    )
    SELECT
      COALESCE((SELECT jsonb_agg(daily ORDER BY "workedOn") FROM daily), '[]'::jsonb) AS days,
      COALESCE((SELECT jsonb_agg(page ORDER BY id DESC) FROM page), '[]'::jsonb) AS entries
    `,
    [
      ...(await entryFilterParams(db, ownerId, filters)),
      filters.day,
      filters.limit,
      filters.offset,
    ],
  );
  return rows[0];
}

export async function createTimeEntry(actor: Actor, input: unknown) {
  assertOwner(actor.ownerId);
  const data = parse(createTimeEntrySchema, input);
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        workedOn: data.workedOn,
        minutes: data.minutes,
        note: data.note,
        projectRef: data.projectRef ?? null,
      }),
    )
    .digest("hex");
  return transaction(async (db) => {
    // Serializes retries even before the first row exists. Keys survive deletion.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `timesheet:${actor.ownerId}:${data.idempotencyKey}`,
    ]);
    const prior = await db.query(
      "SELECT id, input_hash FROM brain_time_entries WHERE owner_id = $1 AND idempotency_key = $2",
      [actor.ownerId, data.idempotencyKey],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].input_hash !== hash)
        throw new BrainError(
          "IDEMPOTENCY_KEY_CONFLICT",
          "This key was already used with different input. Use a new key for a new entry.",
          409,
        );
      return {
        entry: await readEntry(db, actor.ownerId, prior.rows[0].id),
        replayed: true,
      };
    }
    const projectId = data.projectRef
      ? (await resolveProject(db, actor.ownerId, data.projectRef, true)).id
      : null;
    const { rows } = await db.query(
      `INSERT INTO brain_time_entries (owner_id, worked_on, minutes, note, project_id, idempotency_key, input_hash, created_by, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
      [
        actor.ownerId,
        data.workedOn,
        data.minutes,
        data.note,
        projectId,
        data.idempotencyKey,
        hash,
        actor.agentId,
      ],
    );
    return {
      entry: await readEntry(db, actor.ownerId, rows[0].id),
      replayed: false,
    };
  });
}

async function lockEntry(
  db: Database,
  ownerId: string,
  id: string,
  expectedVersion: number,
) {
  const { rows } = await db.query(
    "SELECT version, deleted_at FROM brain_time_entries WHERE owner_id = $1 AND id = $2 FOR UPDATE",
    [ownerId, id],
  );
  if (!rows[0] || rows[0].deleted_at)
    throw new BrainError(
      "TIME_ENTRY_NOT_FOUND",
      "Time entry not found or already deleted.",
      404,
    );
  if (rows[0].version !== expectedVersion)
    throw new BrainError(
      "VERSION_CONFLICT",
      "This entry changed. Read it again before editing or deleting.",
      409,
      { currentVersion: rows[0].version },
    );
}

export async function updateTimeEntry(actor: Actor, input: unknown) {
  assertOwner(actor.ownerId);
  const { id, expectedVersion, patch } = parse(updateTimeEntrySchema, input);
  return transaction(async (db) => {
    await lockEntry(db, actor.ownerId, id, expectedVersion);
    let projectId: string | null = null;
    if (patch.projectRef) {
      const current = await readEntry(db, actor.ownerId, id);
      projectId =
        patch.projectRef === current.projectId ||
        patch.projectRef === current.projectSlug
          ? current.projectId
          : (await resolveProject(db, actor.ownerId, patch.projectRef, true))
              .id;
    }
    await db.query(
      `UPDATE brain_time_entries SET worked_on = COALESCE($3::date, worked_on), minutes = COALESCE($4::int, minutes), note = COALESCE($5::text, note),
      project_id = CASE WHEN $6::boolean THEN $7::uuid ELSE project_id END, version = version + 1, updated_by = $8, updated_at = now()
      WHERE owner_id = $1 AND id = $2`,
      [
        actor.ownerId,
        id,
        patch.workedOn,
        patch.minutes,
        patch.note,
        patch.projectRef !== undefined,
        projectId,
        actor.agentId,
      ],
    );
    return readEntry(db, actor.ownerId, id);
  });
}

export async function deleteTimeEntry(actor: Actor, input: unknown) {
  assertOwner(actor.ownerId);
  const { id, expectedVersion } = parse(deleteTimeEntrySchema, input);
  return transaction(async (db) => {
    await lockEntry(db, actor.ownerId, id, expectedVersion);
    await db.query(
      `UPDATE brain_time_entries SET deleted_at = now(), updated_at = now(), updated_by = $3, version = version + 1 WHERE owner_id = $1 AND id = $2`,
      [actor.ownerId, id, actor.agentId],
    );
    return readEntry(db, actor.ownerId, id);
  });
}
