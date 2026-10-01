import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { transaction } from "../db";
import { hydrateRows, loadPages, type PageRow, recordRevision } from "./pages";
import { BrainError, type BrainPage } from "./types";
import { assertOwner } from "./utils";
export async function readConsolidationPages(
  ownerId: string,
): Promise<BrainPage[]> {
  assertOwner(ownerId);
  return transaction(async (db) => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return loadPages(db, ownerId);
  });
}

function pageContent(page: BrainPage) {
  return {
    id: page.id,
    slug: page.slug,
    type: page.type,
    title: page.title,
    summary: page.summary,
    markdown: page.markdown,
    aliases: page.aliases,
    tags: page.tags,
    links: page.links
      .map(({ sourceId, targetId, type, label }) => ({
        sourceId,
        targetId,
        type,
        label,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

/** Internal helper: the caller owns the transaction and its group receipt. */
export async function writeConsolidationPages(
  db: PoolClient,
  ownerId: string,
  changes: { before: BrainPage; after: BrainPage }[],
  readSet: { pageId: string; version: number }[],
  operationKey: string,
): Promise<
  | { status: "applied"; pages: BrainPage[] }
  | { status: "conflict"; pageIds: string[] }
> {
  assertOwner(ownerId);
  const expected = new Map(
    readSet.map(({ pageId, version }) => [pageId, version]),
  );
  // A stable order prevents concurrent consolidation groups taking opposite
  // locks. NO KEY UPDATE also permits ordinary link inserts' FK key-share locks.
  const locked = await db.query<PageRow>(
    "SELECT * FROM brain_pages WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR NO KEY UPDATE",
    [ownerId, [...expected.keys()].sort()],
  );
  const current = new Map(locked.rows.map((row) => [row.id, row]));
  const conflicts = [...expected]
    .filter(([id, version]) => current.get(id)?.version !== version)
    .map(([id]) => id);
  if (conflicts.length)
    return { status: "conflict", pageIds: conflicts.sort() };
  const originals = new Map(
    (await hydrateRows(db, ownerId, locked.rows)).map((page) => [
      page.id,
      page,
    ]),
  );
  for (const { before } of changes) {
    const original = originals.get(before.id);
    if (
      !original ||
      !isDeepStrictEqual(pageContent(original), pageContent(before))
    )
      throw new BrainError(
        "INVALID_CHANGE_SET",
        "The original page does not match the versioned database content.",
      );
  }
  const updated: PageRow[] = [];
  for (const { before, after } of [...changes].sort((a, b) =>
    a.before.id.localeCompare(b.before.id),
  )) {
    const result = await db.query<PageRow>(
      `UPDATE brain_pages SET markdown=$3,summary=$4,version=version+1,updated_at=now()
       WHERE owner_id=$1 AND id=$2 AND version=$5 RETURNING *`,
      [ownerId, before.id, after.markdown, after.summary, before.version],
    );
    if (!result.rows[0])
      throw new BrainError(
        "VERSION_CONFLICT",
        "The page changed during consolidation.",
        409,
      );
    updated.push(result.rows[0]);
    // Preserve existing link IDs/provenance and add only the verified edges.
    for (const edge of after.links) {
      if (
        before.links.some(
          (existing) =>
            existing.targetId === edge.targetId && existing.type === edge.type,
        )
      )
        continue;
      await db.query(
        "INSERT INTO brain_links (owner_id,source_id,target_id,type,label) VALUES ($1,$2,$3,$4,$5)",
        [ownerId, before.id, edge.targetId, edge.type, edge.label],
      );
    }
  }
  const pages: BrainPage[] = [];
  // Read back after ALL group updates so every revision sees the final graph.
  for (const saved of await hydrateRows(db, ownerId, updated)) {
    const after = changes.find(
      (change) => change.before.id === saved.id,
    )?.after;
    if (!after || !isDeepStrictEqual(pageContent(saved), pageContent(after)))
      throw new BrainError(
        "READBACK_MISMATCH",
        "Saved consolidation content differs from the verified result.",
        500,
      );
    const revisionKey = `consolidation:${createHash("sha256")
      .update(JSON.stringify([operationKey, saved.id]))
      .digest("hex")}`;
    await recordRevision(
      db,
      ownerId,
      saved,
      "write",
      "Verified knowledge consolidation",
      "nightly-consolidation",
      revisionKey,
    );
    pages.push(saved);
  }
  return { status: "applied", pages };
}
