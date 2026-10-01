import { getPool } from "../db";
import { iso } from "./pages";
import * as schemas from "./schemas";
import { type Activity, BrainError, type PageRevision } from "./types";
import { assertOwner } from "./utils";
export async function listRevisionSummaries(
  ownerId: string,
  input: unknown,
): Promise<Omit<PageRevision, "snapshot">[]> {
  assertOwner(ownerId);
  const data = schemas.revisionsSchema.parse(input);
  const result = await getPool().query(
    `SELECT r.id,r.page_id,r.version,r.reason,r.source,r.created_at
     FROM brain_revisions r JOIN brain_pages p ON p.id=r.page_id AND p.owner_id=r.owner_id
     WHERE r.owner_id=$1 AND (p.id::text=$2 OR p.slug=$2)
     ORDER BY r.version DESC LIMIT $3 OFFSET $4`,
    [ownerId, data.ref, data.limit, data.offset],
  );
  return result.rows.map((row) => ({
    id: row.id,
    pageId: row.page_id,
    version: row.version,
    reason: row.reason,
    source: row.source,
    createdAt: iso(row.created_at),
  }));
}

export async function readRevision(
  ownerId: string,
  input: unknown,
): Promise<PageRevision> {
  assertOwner(ownerId);
  const data = schemas.revisionSchema.parse(input);
  const result = await getPool().query(
    `SELECT r.* FROM brain_revisions r JOIN brain_pages p ON p.id=r.page_id AND p.owner_id=r.owner_id
     WHERE r.owner_id=$1 AND (p.id::text=$2 OR p.slug=$2) AND r.version=$3`,
    [ownerId, data.ref, data.version],
  );
  const row = result.rows[0];
  if (!row) throw new BrainError("NOT_FOUND", "Page revision not found.", 404);
  return {
    id: row.id,
    pageId: row.page_id,
    version: row.version,
    // Snapshots saved before company relationships existed lack the field.
    snapshot: {
      ...row.snapshot,
      relationships: row.snapshot.relationships ?? [],
    },
    reason: row.reason,
    source: row.source,
    createdAt: iso(row.created_at),
  };
}

export async function listActivity(
  ownerId: string,
  input: unknown = {},
): Promise<Activity[]> {
  assertOwner(ownerId);
  const { limit, offset } = schemas.activitySchema.parse(input);
  const result = await getPool().query(
    `SELECT a.*,p.title,p.slug FROM brain_activity a JOIN brain_pages p ON p.owner_id=a.owner_id AND p.id=a.page_id
    WHERE a.owner_id=$1 ORDER BY a.created_at DESC,a.id DESC LIMIT $2 OFFSET $3`,
    [ownerId, limit, offset],
  );
  return result.rows.map((row) => ({
    id: row.id,
    pageId: row.page_id,
    title: row.title,
    slug: row.slug,
    action: row.action,
    version: row.version,
    reason: row.reason,
    source: row.source,
    createdAt: iso(row.created_at),
  }));
}
