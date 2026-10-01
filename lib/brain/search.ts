import { getPool, transaction } from "../db";
import { CHUNKER_VERSION } from "./chunks";
import { getQueryEmbedding } from "./embeddings";
import {
  type Database,
  escapeLike,
  link,
  PAGE_COLUMNS,
  type PageRow,
  rowForRef,
  summary,
} from "./pages";
import * as schemas from "./schemas";
import type { SearchResult } from "./types";
import {
  assertEmbeddingModel,
  assertOwner,
  embeddingModel,
  normalizeIdentity,
  reciprocalRankScore,
  vectorLiteral,
} from "./utils";
export async function resolve(ownerId: string, input: unknown) {
  assertOwner(ownerId);
  const data = schemas.resolveSchema.parse(input);
  const name = normalizeIdentity(data.name);
  const result = await getPool().query<
    PageRow & { confidence: number; exact: boolean }
  >(
    `SELECT ${PAGE_COLUMNS},
    max(CASE WHEN i.identity_key=$2 OR p.slug=$2 THEN 1 ELSE similarity(i.identity_key,$2) END) AS confidence,
    bool_or(i.identity_key=$2 OR p.slug=$2) AS exact FROM brain_pages p
    JOIN brain_identities i ON i.owner_id=p.owner_id AND i.page_id=p.id
    WHERE p.owner_id=$1 AND ($3::text IS NULL OR p.type=$3) AND
      (i.identity_key=$2 OR p.slug=$2 OR similarity(i.identity_key,$2)>0.22 OR i.identity_key ILIKE $5)
    GROUP BY p.id ORDER BY exact DESC,confidence DESC,p.updated_at DESC LIMIT $4`,
    [ownerId, name, data.type ?? null, data.limit, `%${escapeLike(name)}%`],
  );
  const candidates = result.rows.map((row) => ({
    ...summary(row),
    confidence: Number(row.confidence),
    exact: row.exact,
  }));
  const exact = candidates.filter((candidate) => candidate.exact);
  return {
    match: exact.length === 1 ? exact[0] : null,
    ambiguous: exact.length > 1,
    candidates,
    instruction:
      exact.length === 1
        ? "Read the matched page before writing."
        : candidates.length
          ? "Inspect candidates before creating a new entity; matching names may represent different entities."
          : "No candidate found. A new entity can be created with expectedVersion 0.",
  };
}

export interface SearchRetrieval {
  mode: "hybrid" | "text-and-graph";
  embeddingModel: string | null;
  embeddingSource: "server" | "client" | "unavailable";
}

export async function search(
  ownerId: string,
  input: unknown,
): Promise<{ results: SearchResult[]; retrieval: SearchRetrieval }> {
  assertOwner(ownerId);
  const data = schemas.searchSchema.parse(input);
  assertEmbeddingModel(data.embeddingModel, Boolean(data.embedding));
  const queryEmbedding = data.embedding
    ? {
        embedding: data.embedding,
        embeddingModel: data.embeddingModel ?? embeddingModel(),
      }
    : await getQueryEmbedding(ownerId, data.query);
  const retrieval: SearchRetrieval = {
    mode: queryEmbedding ? "hybrid" : "text-and-graph",
    embeddingModel: queryEmbedding?.embeddingModel ?? null,
    embeddingSource: data.embedding
      ? "client"
      : queryEmbedding
        ? "server"
        : "unavailable",
  };
  const candidates = Math.max(data.limit * 4, 60);
  const query = (
    db: Database,
    chunkCandidateLimit: number | null = Math.min(20_000, candidates * 32),
  ) =>
    db.query<
      PageRow & {
        text_rank: string | null;
        vector_rank: string | null;
        excerpt: string;
        matched_content: string | null;
        start_offset: number | null;
        end_offset: number | null;
        semantic_count: number;
      }
    >(
      `
    WITH lexical_candidates AS (
      SELECT p.id, ts_rank_cd(p.search_document, websearch_to_tsquery('simple',$2))
        + CASE WHEN lower(p.title)=lower($2) THEN 2 ELSE 0 END
        + similarity(p.title,$2) * 0.2 AS rank
      FROM brain_pages p WHERE p.owner_id=$1 AND ($3::text IS NULL OR p.type=$3)
      AND (p.search_document @@ websearch_to_tsquery('simple',$2) OR p.title ILIKE $7
        OR EXISTS (SELECT 1 FROM unnest(p.aliases) alias WHERE alias ILIKE $7))
      ORDER BY rank DESC,p.id LIMIT $5
    ), lexical AS (SELECT id,row_number() OVER (ORDER BY rank DESC,id) AS text_rank FROM lexical_candidates),
    chunk_candidates AS MATERIALIZED (
      SELECT p.id,c.embedding <=> $4::vector AS distance,c.content,c.start_offset,c.end_offset
      FROM brain_page_chunks c JOIN brain_pages p ON p.owner_id=c.owner_id AND p.id=c.page_id
      WHERE c.owner_id=$1 AND ($3::text IS NULL OR p.type=$3) AND $4::vector IS NOT NULL
        AND c.embedding_model=$6 AND c.page_version=p.version AND c.chunker_version=$9
        AND p.chunk_index_version=p.version AND p.chunk_index_model=c.embedding_model
        AND p.chunk_index_chunker=c.chunker_version
      ORDER BY c.embedding <=> $4::vector LIMIT $10
    ), chunk_pages AS (
      SELECT DISTINCT ON (id) id,distance,content,start_offset,end_offset FROM chunk_candidates
      ORDER BY id,distance,start_offset
    ), semantic AS (
      SELECT id,content,start_offset,end_offset,row_number() OVER (ORDER BY distance,id) AS vector_rank
      FROM chunk_pages ORDER BY distance,id LIMIT $5
    ), fused AS (SELECT coalesce(l.id,s.id) id,l.text_rank,s.vector_rank,s.content,s.start_offset,s.end_offset
      FROM lexical l FULL OUTER JOIN semantic s USING (id))
    SELECT ${PAGE_COLUMNS},f.text_rank,f.vector_rank,coalesce(f.content,left(p.markdown,500)) AS excerpt,
      f.content AS matched_content,f.start_offset,f.end_offset,
      (SELECT count(*)::integer FROM semantic) AS semantic_count
      FROM fused f JOIN brain_pages p ON p.id=f.id AND p.owner_id=$1
      ORDER BY (coalesce(1.0/(60+f.text_rank),0)+coalesce(1.0/(60+f.vector_rank),0)) DESC,p.updated_at DESC LIMIT $8`,
      [
        ownerId,
        data.query,
        data.type ?? null,
        queryEmbedding ? vectorLiteral(queryEmbedding.embedding) : null,
        candidates,
        queryEmbedding?.embeddingModel ?? embeddingModel(),
        `%${escapeLike(data.query)}%`,
        data.limit,
        CHUNKER_VERSION,
        chunkCandidateLimit,
      ],
    );
  const result = queryEmbedding
    ? await transaction(async (db) => {
        // Approximate scans filter by owner/type after visiting candidates. Keep
        // scanning to fill the pool, while bounding effort and avoiding pooled
        // connection settings leaking into another request.
        await db.query(
          "SELECT set_config('hnsw.iterative_scan','strict_order',true), set_config('hnsw.ef_search',$1,true), set_config('hnsw.max_scan_tuples','20000',true)",
          [String(candidates)],
        );
        const approximate = await query(db);
        // A long page can occupy an ANN candidate pool with many sections.
        // Fill missing distinct-page slots with an exact scan rather than
        // silently returning only that page. Small corpora make this cheap.
        if ((approximate.rows[0]?.semantic_count ?? 0) < data.limit) {
          await db.query("SET LOCAL enable_indexscan = off");
          return query(db, null);
        }
        return approximate;
      })
    : await query(getPool());
  const hits: SearchResult[] = result.rows.map((row) => ({
    ...summary(row),
    score: reciprocalRankScore(
      Number(row.text_rank) || null,
      Number(row.vector_rank) || null,
    ),
    excerpt: row.excerpt,
    ...(row.matched_content !== null
      ? {
          matchedPassage: {
            content: row.matched_content,
            startOffset: row.start_offset ?? 0,
            endOffset: row.end_offset ?? 0,
          },
        }
      : {}),
    matchedBy: [
      ...(row.text_rank ? ["text" as const] : []),
      ...(row.vector_rank ? ["vector" as const] : []),
    ],
  }));
  if (!data.expandGraph || !hits.length) return { results: hits, retrieval };
  const seedIds = hits.slice(0, 5).map((page) => page.id);
  const graph = await getPool().query<
    PageRow & { excerpt: string; seed_id: string }
  >(
    `SELECT DISTINCT ON (p.id) ${PAGE_COLUMNS},left(p.markdown,500) AS excerpt,
    CASE WHEN l.source_id=ANY($2::uuid[]) THEN l.source_id ELSE l.target_id END AS seed_id
    FROM brain_links l JOIN brain_pages p ON p.owner_id=l.owner_id AND
      p.id=CASE WHEN l.source_id=ANY($2::uuid[]) THEN l.target_id ELSE l.source_id END
    WHERE l.owner_id=$1 AND (l.source_id=ANY($2::uuid[]) OR l.target_id=ANY($2::uuid[]))
      AND NOT p.id=ANY($3::uuid[]) AND ($4::text IS NULL OR p.type=$4)
    ORDER BY p.id,p.updated_at DESC LIMIT $5`,
    [
      ownerId,
      seedIds,
      hits.map((page) => page.id),
      data.type ?? null,
      data.limit,
    ],
  );
  for (const row of graph.rows) {
    hits.push({
      ...summary(row),
      score: (hits.find((page) => page.id === row.seed_id)?.score ?? 0) * 0.35,
      excerpt: row.excerpt,
      matchedBy: ["graph"],
    });
  }
  return {
    results: hits.sort((a, b) => b.score - a.score).slice(0, data.limit),
    retrieval,
  };
}

export async function related(ownerId: string, input: unknown) {
  assertOwner(ownerId);
  const data = schemas.relatedSchema.parse(input);
  const seed = await rowForRef(getPool(), ownerId, data.ref);
  const result = await getPool().query<PageRow & { depth: number }>(
    `WITH RECURSIVE reachable(id,depth) AS (
    SELECT $2::uuid,0 UNION SELECT CASE WHEN l.source_id=r.id THEN l.target_id ELSE l.source_id END,r.depth+1
    FROM reachable r JOIN brain_links l ON l.owner_id=$1 AND (l.source_id=r.id OR l.target_id=r.id) WHERE r.depth<$3
  ) SELECT ${PAGE_COLUMNS},min(r.depth) AS depth FROM reachable r JOIN brain_pages p ON p.owner_id=$1 AND p.id=r.id
    WHERE r.id<>$2 GROUP BY p.id ORDER BY depth,p.updated_at DESC LIMIT $4`,
    [ownerId, seed.id, data.depth, data.limit],
  );
  const pages = result.rows.map((row) => ({
    ...summary(row),
    depth: row.depth,
  }));
  const ids = [seed.id, ...pages.map((page) => page.id)];
  const links = await getPool().query(
    "SELECT * FROM brain_links WHERE owner_id=$1 AND source_id=ANY($2::uuid[]) AND target_id=ANY($2::uuid[])",
    [ownerId, ids],
  );
  return { page: summary(seed), pages, links: links.rows.map(link) };
}
