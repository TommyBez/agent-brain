import { allowedEmails } from "../auth";
import type { Database } from "../brain/pages";
import { assertOwner } from "../brain/utils";
import { getPool } from "../db";
import type { Actor } from "./actors";
import { assertOwnerActor } from "./mutations";

// The task manager is a per-owner setting, off until the owner turns it on in
// Agents & access. While it is off every task surface behaves as before the
// release: no task tools or instructions over MCP, no task pages, no task
// phases at night. Turning it off hides tasks; it never deletes them.

/** Whether this owner has turned the task manager on. */
export async function tasksEnabledFor(
  ownerId: string,
  db: Database = getPool(),
): Promise<boolean> {
  assertOwner(ownerId);
  const { rows } = await db.query<{ enabled: boolean }>(
    "SELECT enabled FROM brain_task_settings WHERE owner_id = $1",
    [ownerId],
  );
  return rows[0]?.enabled === true;
}

/** Turns the owner's task manager on or off. Only the owner can. */
export async function setTasksEnabled(
  actor: Actor,
  enabled: boolean,
): Promise<{ enabled: boolean }> {
  assertOwnerActor(actor);
  const { rows } = await getPool().query<{ enabled: boolean }>(
    `INSERT INTO brain_task_settings (owner_id, enabled) VALUES ($1, $2)
     ON CONFLICT (owner_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
     RETURNING enabled`,
    [actor.ownerId, enabled],
  );
  return { enabled: rows[0].enabled };
}

/** Allowlisted accounts that exist and have the task manager on (§8.4 budget). */
export async function tasksEnabledAccountCount(
  db: Database = getPool(),
): Promise<number> {
  const emails = allowedEmails();
  if (!emails.length) return 0;
  const { rows } = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM "user" u
     JOIN brain_task_settings s ON s.owner_id = u.id AND s.enabled
     WHERE lower(u.email) = ANY($1::text[])`,
    [emails],
  );
  return rows[0]?.count ?? 0;
}
