import { getPool } from "../db";
import { CHUNKER_VERSION } from "./chunks";
import { pendingEmbeddingsSql } from "./embedding-state";
import {
  escapeLike,
  iso,
  link,
  PAGE_COLUMNS,
  type PageRow,
  summary,
} from "./pages";
import * as schemas from "./schemas";
import type { BrainStats, PageType } from "./types";
import { assertOwner, embeddingModel } from "./utils";
export async function listPages(ownerId: string, input: unknown = {}) {
  assertOwner(ownerId);
  const data = schemas.listPagesSchema.parse(input);
  const params = [
    ownerId,
    data.type ?? null,
    data.query ? `%${escapeLike(data.query)}%` : null,
  ];
  const filter =
    "p.owner_id=$1 AND ($2::text IS NULL OR p.type=$2) AND ($3::text IS NULL OR p.title ILIKE $3 OR p.summary ILIKE $3 OR p.markdown ILIKE $3 OR EXISTS(SELECT 1 FROM unnest(p.aliases) alias WHERE alias ILIKE $3))";
  const order =
    data.sort === "title" ? "lower(p.title),p.id" : "p.updated_at DESC,p.id";
  const [pages, count] = await Promise.all([
    getPool().query<PageRow>(
      `SELECT ${PAGE_COLUMNS} FROM brain_pages p WHERE ${filter} ORDER BY ${order} LIMIT $4 OFFSET $5`,
      [...params, data.limit, data.offset],
    ),
    getPool().query<{ total: string }>(
      `SELECT count(*) AS total FROM brain_pages p WHERE ${filter}`,
      params,
    ),
  ]);
  return { pages: pages.rows.map(summary), total: Number(count.rows[0].total) };
}

export async function getGraph(ownerId: string, input: unknown = {}) {
  assertOwner(ownerId);
  const { limit, offset, type } = schemas.graphSchema.parse(input);
  const [nodes, count] = await Promise.all([
    getPool().query<PageRow>(
      `SELECT ${PAGE_COLUMNS} FROM brain_pages p WHERE p.owner_id=$1 AND ($2::text IS NULL OR p.type=$2) ORDER BY p.updated_at DESC,p.id LIMIT $3 OFFSET $4`,
      [ownerId, type ?? null, limit, offset],
    ),
    getPool().query<{ total: number }>(
      "SELECT count(*)::int AS total FROM brain_pages WHERE owner_id=$1 AND ($2::text IS NULL OR type=$2)",
      [ownerId, type ?? null],
    ),
  ]);
  const ids = nodes.rows.map((row) => row.id);
  const edges = await getPool().query(
    "SELECT * FROM brain_links WHERE owner_id=$1 AND source_id=ANY($2::uuid[]) AND target_id=ANY($2::uuid[])",
    [ownerId, ids],
  );
  return {
    nodes: nodes.rows.map(summary),
    links: edges.rows.map(link),
    total: count.rows[0].total,
  };
}

export async function getStats(ownerId: string): Promise<BrainStats> {
  assertOwner(ownerId);
  const [result, counts] = await Promise.all([
    getPool().query(
      `SELECT count(*)::int AS pages,
    count(*) FILTER (WHERE NOT ${pendingEmbeddingsSql()})::int AS embedded_pages,
    max(updated_at) AS last_updated,
    (SELECT count(*)::int FROM brain_links WHERE owner_id=$1) AS links,
    (SELECT count(*)::int FROM brain_revisions WHERE owner_id=$1) AS revisions FROM brain_pages WHERE owner_id=$1`,
      [ownerId, embeddingModel(), CHUNKER_VERSION],
    ),
    getPool().query<{ type: PageType; count: number }>(
      "SELECT type,count(*)::int AS count FROM brain_pages WHERE owner_id=$1 GROUP BY type",
      [ownerId],
    ),
  ]);
  const row = result.rows[0];
  return {
    pages: row.pages,
    links: row.links,
    revisions: row.revisions,
    embeddedPages: row.embedded_pages,
    lastUpdated: row.last_updated ? iso(row.last_updated) : null,
    byType: Object.fromEntries(
      counts.rows.map((item) => [item.type, item.count]),
    ),
  };
}

export async function gapAnalysis(ownerId: string) {
  assertOwner(ownerId);
  const [unlinked, stale, duplicates, pending] = await Promise.all([
    getPool().query<PageRow>(
      `SELECT ${PAGE_COLUMNS} FROM brain_pages p WHERE p.owner_id=$1
      AND NOT EXISTS(SELECT 1 FROM brain_links l WHERE l.owner_id=$1 AND (l.source_id=p.id OR l.target_id=p.id)) ORDER BY p.updated_at DESC LIMIT 40`,
      [ownerId],
    ),
    getPool().query<PageRow>(
      `SELECT ${PAGE_COLUMNS} FROM brain_pages p WHERE p.owner_id=$1 AND p.updated_at<now()-interval '90 days' ORDER BY p.updated_at LIMIT 40`,
      [ownerId],
    ),
    getPool().query(
      `SELECT a.id AS first_id,a.title AS first_title,b.id AS second_id,b.title AS second_title,similarity(a.title,b.title) AS similarity
      FROM brain_pages a JOIN brain_pages b ON b.owner_id=a.owner_id AND b.type=a.type AND b.id>a.id
      WHERE a.owner_id=$1 AND similarity(a.title,b.title)>0.5 ORDER BY similarity DESC LIMIT 30`,
      [ownerId],
    ),
    getPool().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM brain_pages WHERE owner_id=$1
       AND ${pendingEmbeddingsSql()}`,
      [ownerId, embeddingModel(), CHUNKER_VERSION],
    ),
  ]);
  return {
    unlinkedPages: unlinked.rows.map(summary),
    stalePages: stale.rows.map(summary),
    possibleDuplicates: duplicates.rows.map((row) => ({
      first: { id: row.first_id, title: row.first_title },
      second: { id: row.second_id, title: row.second_title },
      similarity: Number(row.similarity),
    })),
    pendingEmbeddings: pending.rows[0].count,
    instruction:
      "Review candidates against source pages. Similar names are not proof of identity; consolidate only with evidence and current page versions.",
  };
}
