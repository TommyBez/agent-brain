import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { transaction } from "../db";
import * as schemas from "./schemas";
import {
  BrainError,
  type BrainLink,
  type BrainPage,
  type CompanyRelationship,
  type DecoratedLink,
  type DecoratedPage,
  MAX_PAGE_CHARACTERS,
  type PageSummary,
  type PageType,
} from "./types";
import {
  assertOwner,
  assertVersion,
  normalizeIdentity,
  slugify,
} from "./utils";
export type Database = Pool | PoolClient;
export interface PageRow extends QueryResultRow {
  id: string;
  slug: string;
  title: string;
  type: PageType;
  summary: string;
  relationships: CompanyRelationship[];
  aliases: string[];
  tags: string[];
  version: number;
  markdown: string;
  created_at: Date;
  updated_at: Date;
  chunk_index_version: number | null;
  chunk_indexed_at: Date | null;
}
export const PAGE_COLUMNS =
  "p.id, p.slug, p.title, p.type, p.summary, p.relationships, p.aliases, p.tags, p.version, p.created_at, p.updated_at, p.chunk_index_version, p.chunk_indexed_at";
export const iso = (value: Date | string): string =>
  new Date(value).toISOString();
export function summary(row: PageRow): PageSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    type: row.type,
    summary: row.summary,
    relationships: row.relationships,
    aliases: row.aliases,
    tags: row.tags,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    embeddedAt:
      row.chunk_index_version === row.version && row.chunk_indexed_at
        ? iso(row.chunk_indexed_at)
        : null,
  };
}
export function link(row: QueryResultRow): BrainLink {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    type: row.type,
    label: row.label,
  };
}
export function decoratedLink(row: QueryResultRow): DecoratedLink {
  return {
    ...link(row),
    targetTitle: row.target_title,
    targetSlug: row.target_slug,
    sourceTitle: row.source_title,
    sourceSlug: row.source_slug,
  };
}
export function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function rowForRef(
  db: Database,
  ownerId: string,
  ref: string,
  lock = false,
): Promise<PageRow> {
  const result = await db.query<PageRow>(
    `SELECT p.* FROM brain_pages p WHERE p.owner_id = $1 AND (p.id::text = $2 OR p.slug = $2) ${lock ? "FOR UPDATE" : ""}`,
    [ownerId, ref],
  );
  if (!result.rows[0])
    throw new BrainError(
      "NOT_FOUND",
      "Page not found. Use its id or canonical slug from resolve/search.",
      404,
    );
  return result.rows[0];
}

export function assemblePage(
  row: PageRow,
  links: DecoratedLink[],
): DecoratedPage {
  return {
    ...summary(row),
    markdown: row.markdown,
    links: links.filter((edge) => edge.sourceId === row.id),
    backlinks: links.filter((edge) => edge.targetId === row.id),
  };
}

export async function hydrateRows(
  db: Database,
  ownerId: string,
  rows: PageRow[],
): Promise<DecoratedPage[]> {
  if (!rows.length) return [];
  const result = await db.query(
    `SELECT l.*, target.title AS target_title, target.slug AS target_slug, source.title AS source_title, source.slug AS source_slug
     FROM brain_links l JOIN brain_pages target ON target.owner_id=l.owner_id AND target.id=l.target_id
     JOIN brain_pages source ON source.owner_id=l.owner_id AND source.id=l.source_id
     WHERE l.owner_id=$1 AND (l.source_id=ANY($2::uuid[]) OR l.target_id=ANY($2::uuid[]))
     ORDER BY l.type, target.title, l.source_id, l.target_id, l.id`,
    [ownerId, rows.map((row) => row.id)],
  );
  const byPage = new Map<string, DecoratedLink[]>();
  for (const row of result.rows) {
    const edge = decoratedLink(row);
    for (const id of new Set([edge.sourceId, edge.targetId])) {
      const edges = byPage.get(id) ?? [];
      edges.push(edge);
      byPage.set(id, edges);
    }
  }
  return rows.map((row) => assemblePage(row, byPage.get(row.id) ?? []));
}

/** Caller owns a repeatable-read transaction; refs accept canonical IDs or slugs. */
export async function loadPages(
  db: Database,
  ownerId: string,
  refs?: string[],
): Promise<DecoratedPage[]> {
  const result = await db.query<PageRow>(
    `SELECT * FROM brain_pages WHERE owner_id=$1 ${refs ? "AND (id::text=ANY($2::text[]) OR slug=ANY($2::text[]))" : ""} ORDER BY id`,
    refs ? [ownerId, refs] : [ownerId],
  );
  return hydrateRows(db, ownerId, result.rows);
}

export async function pageFromRow(
  db: Database,
  ownerId: string,
  row: PageRow,
): Promise<DecoratedPage> {
  return (await hydrateRows(db, ownerId, [row]))[0];
}

export async function recordRevision(
  db: PoolClient,
  ownerId: string,
  page: BrainPage,
  action: "create" | "write" | "append",
  reason: string,
  source: string,
  operationKey?: string,
) {
  await db.query(
    "INSERT INTO brain_revisions (owner_id,page_id,version,snapshot,reason,source,operation_key) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)",
    [
      ownerId,
      page.id,
      page.version,
      JSON.stringify(page),
      reason,
      source,
      operationKey ?? null,
    ],
  );
  await db.query(
    "INSERT INTO brain_activity (owner_id,page_id,action,version,reason,source) VALUES ($1,$2,$3,$4,$5,$6)",
    [ownerId, page.id, action, page.version, reason, source],
  );
}

export async function read(
  ownerId: string,
  input: unknown,
): Promise<DecoratedPage> {
  assertOwner(ownerId);
  const { ref } = schemas.readSchema.parse(input);
  return transaction(async (db) => {
    // Read the body/version and typed links from the same committed state.
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return pageFromRow(db, ownerId, await rowForRef(db, ownerId, ref));
  });
}

export async function write(
  ownerId: string,
  input: unknown,
): Promise<DecoratedPage> {
  assertOwner(ownerId);
  const data = schemas.writeSchema.parse(input);
  try {
    return await transaction(async (db) => {
      const existing = data.id
        ? await rowForRef(db, ownerId, data.id, true)
        : null;
      if (existing) assertVersion(existing.version, data.expectedVersion);
      const id = existing?.id ?? randomUUID();
      const slug =
        data.slug ??
        existing?.slug ??
        `${data.type}/${slugify(data.title) || id}`;
      const version = (existing?.version ?? 0) + 1;
      const aliases = [...new Set(data.aliases)];
      const tags = [...new Set(data.tags)];
      const relationships = [...new Set(data.relationships)];
      const identities = [
        ...new Set([data.title, ...aliases].map(normalizeIdentity)),
      ];
      if (existing)
        await db.query(
          "DELETE FROM brain_identities WHERE owner_id=$1 AND page_id=$2",
          [ownerId, id],
        );
      const values = [
        ownerId,
        id,
        slug,
        data.type,
        data.title,
        data.summary,
        data.markdown,
        aliases,
        tags,
        version,
        relationships,
      ];
      const result = existing
        ? await db.query<PageRow>(
            `UPDATE brain_pages SET slug=$3,type=$4,title=$5,summary=$6,markdown=$7,aliases=$8,tags=$9,version=$10,relationships=$11,updated_at=now()
            WHERE owner_id=$1 AND id=$2 RETURNING *`,
            values,
          )
        : await db.query<PageRow>(
            `INSERT INTO brain_pages (owner_id,id,slug,type,title,summary,markdown,aliases,tags,version,relationships)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            values,
          );
      await db.query(
        "INSERT INTO brain_identities (owner_id,page_id,type,identity_key) SELECT $1,$2,$3,unnest($4::text[])",
        [ownerId, id, data.type, identities],
      );
      await db.query(
        "DELETE FROM brain_links WHERE owner_id=$1 AND source_id=$2",
        [ownerId, id],
      );
      if (data.links.length) {
        const targets = await db.query<{ id: string; slug: string }>(
          "SELECT id,slug FROM brain_pages WHERE owner_id=$1 AND (id::text=ANY($2::text[]) OR slug=ANY($2::text[]))",
          [ownerId, data.links.map((edge) => edge.targetRef)],
        );
        const resolved = new Map(
          targets.rows.flatMap((row) => [
            [row.id, row.id],
            [row.slug, row.id],
          ]),
        );
        const edges = new Map<
          string,
          { target_id: string; type: string; label: string }
        >();
        for (const edge of data.links) {
          const targetId = resolved.get(edge.targetRef);
          if (!targetId)
            throw new BrainError(
              "NOT_FOUND",
              "Page not found. Use its id or canonical slug from resolve/search.",
              404,
            );
          if (targetId === id)
            throw new BrainError(
              "INVALID_LINK",
              "A page cannot link to itself",
            );
          edges.set(`${targetId}:${edge.type}`, {
            target_id: targetId,
            type: edge.type,
            label: edge.label,
          });
        }
        await db.query(
          `INSERT INTO brain_links (owner_id,source_id,target_id,type,label)
           SELECT $1,$2,x.target_id,x.type,x.label FROM jsonb_to_recordset($3::jsonb) AS x(target_id uuid,type text,label text)`,
          [ownerId, id, JSON.stringify([...edges.values()])],
        );
      }
      const page = await pageFromRow(db, ownerId, result.rows[0]);
      await recordRevision(
        db,
        ownerId,
        page,
        existing ? "write" : "create",
        data.reason,
        data.source,
      );
      return page;
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505"
    )
      throw new BrainError(
        "DUPLICATE_ENTITY",
        "A page with this slug, name or alias already exists. Run resolve, read the existing page, then reconcile the update.",
        409,
      );
    throw error;
  }
}

export async function append(
  ownerId: string,
  input: unknown,
): Promise<DecoratedPage> {
  assertOwner(ownerId);
  const data = schemas.appendSchema.parse(input);
  return transaction(async (db) => {
    const current = await rowForRef(db, ownerId, data.ref, true);
    assertVersion(current.version, data.expectedVersion);
    const markdown = `${current.markdown.trimEnd()}\n\n${data.markdown}\n`;
    if (markdown.length > MAX_PAGE_CHARACTERS)
      throw new BrainError(
        "PAGE_TOO_LARGE",
        "The combined page exceeds 200,000 characters. Consolidate it before appending.",
      );
    const result = await db.query<PageRow>(
      `UPDATE brain_pages SET markdown=$3,version=version+1,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING *`,
      [ownerId, current.id, markdown],
    );
    const page = await pageFromRow(db, ownerId, result.rows[0]);
    await recordRevision(db, ownerId, page, "append", data.reason, data.source);
    return page;
  });
}
