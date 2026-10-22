import { randomUUID } from "node:crypto";
import type { Database } from "../brain/pages";
import { assertOwner } from "../brain/utils";
import { getPool, transaction } from "../db";
import type { Actor } from "./actors";
import { parseTaskInput, taskError } from "./errors";
import { assertOwnerActor } from "./mutations";
import { resolvePages, resolveProject } from "./page-links";
import { savedViewSchema } from "./schemas";

// Owner task settings: paused projects stop queue distribution, keeper
// exclusions keep confidential pages away from extraction, saved views are
// named URL filters for /tasks.

export const MAX_SAVED_VIEWS = 50;

export interface SavedTaskView {
  id: string;
  name: string;
  query: string;
}

export interface TaskSettings {
  pausedProjectIds: string[];
  keeperExcludedPageIds: string[];
  savedViews: SavedTaskView[];
  updatedAt: string | null;
}

async function readSettings(
  db: Database,
  ownerId: string,
): Promise<TaskSettings> {
  const { rows } = await db.query(
    `SELECT paused_project_ids, keeper_excluded_page_ids, saved_views, updated_at
     FROM brain_task_settings WHERE owner_id = $1`,
    [ownerId],
  );
  const row = rows[0];
  return {
    pausedProjectIds: row?.paused_project_ids ?? [],
    keeperExcludedPageIds: row?.keeper_excluded_page_ids ?? [],
    savedViews: row?.saved_views ?? [],
    updatedAt: row ? new Date(row.updated_at).toISOString() : null,
  };
}

export async function getTaskSettings(ownerId: string): Promise<TaskSettings> {
  assertOwner(ownerId);
  return readSettings(getPool(), ownerId);
}

async function lockSettings(db: Database, ownerId: string) {
  await db.query(
    "INSERT INTO brain_task_settings (owner_id) VALUES ($1) ON CONFLICT (owner_id) DO NOTHING",
    [ownerId],
  );
  await db.query(
    "SELECT 1 FROM brain_task_settings WHERE owner_id = $1 FOR UPDATE",
    [ownerId],
  );
}

function toggle(values: string[], id: string, on: boolean): string[] {
  const rest = values.filter((value) => value !== id);
  return on ? [...rest, id] : rest;
}

/** Pausing a project stops queue claims; on-request claims still work. */
export async function setProjectPaused(
  actor: Actor,
  projectRef: string,
  paused: boolean,
): Promise<TaskSettings> {
  assertOwnerActor(actor);
  return transaction(async (db) => {
    const project = await resolveProject(db, actor.ownerId, projectRef);
    await lockSettings(db, actor.ownerId);
    const current = await readSettings(db, actor.ownerId);
    await db.query(
      "UPDATE brain_task_settings SET paused_project_ids = $2::uuid[], updated_at = now() WHERE owner_id = $1",
      [actor.ownerId, toggle(current.pausedProjectIds, project.id, paused)],
    );
    return readSettings(db, actor.ownerId);
  });
}

/** Excluded pages are never read by the task keeper. */
export async function setKeeperExcluded(
  actor: Actor,
  pageRef: string,
  excluded: boolean,
): Promise<TaskSettings> {
  assertOwnerActor(actor);
  return transaction(async (db) => {
    const [page] = await resolvePages(db, actor.ownerId, [pageRef]);
    await lockSettings(db, actor.ownerId);
    const current = await readSettings(db, actor.ownerId);
    await db.query(
      "UPDATE brain_task_settings SET keeper_excluded_page_ids = $2::uuid[], updated_at = now() WHERE owner_id = $1",
      [actor.ownerId, toggle(current.keeperExcludedPageIds, page.id, excluded)],
    );
    return readSettings(db, actor.ownerId);
  });
}

/** Saves (or renames in place, by name) a named /tasks filter. */
export async function saveTaskView(
  actor: Actor,
  input: unknown,
): Promise<TaskSettings> {
  assertOwnerActor(actor);
  const data = parseTaskInput(savedViewSchema, input);
  return transaction(async (db) => {
    await lockSettings(db, actor.ownerId);
    const current = await readSettings(db, actor.ownerId);
    const existing = current.savedViews.find((view) => view.name === data.name);
    const views = existing
      ? current.savedViews.map((view) =>
          view.id === existing.id ? { ...view, query: data.query } : view,
        )
      : [...current.savedViews, { id: randomUUID(), ...data }];
    if (views.length > MAX_SAVED_VIEWS)
      throw taskError(
        "INVALID_INPUT",
        `At most ${MAX_SAVED_VIEWS} saved views.`,
        "Delete a saved view first.",
      );
    await db.query(
      "UPDATE brain_task_settings SET saved_views = $2::jsonb, updated_at = now() WHERE owner_id = $1",
      [actor.ownerId, JSON.stringify(views)],
    );
    return readSettings(db, actor.ownerId);
  });
}

export async function deleteTaskView(
  actor: Actor,
  viewId: string,
): Promise<TaskSettings> {
  assertOwnerActor(actor);
  return transaction(async (db) => {
    await lockSettings(db, actor.ownerId);
    const current = await readSettings(db, actor.ownerId);
    await db.query(
      "UPDATE brain_task_settings SET saved_views = $2::jsonb, updated_at = now() WHERE owner_id = $1",
      [
        actor.ownerId,
        JSON.stringify(current.savedViews.filter((view) => view.id !== viewId)),
      ],
    );
    return readSettings(db, actor.ownerId);
  });
}
