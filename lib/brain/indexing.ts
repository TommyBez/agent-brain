import { getPool, transaction } from "../db";
import { CHUNKER_VERSION, chunkPage } from "./chunks";
import { pendingEmbeddingsSql } from "./embedding-state";
import { PAGE_COLUMNS, type PageRow, rowForRef, summary } from "./pages";
import * as schemas from "./schemas";
import { BrainError } from "./types";
import {
  assertEmbeddingModel,
  assertOwner,
  assertVersion,
  embeddingModel,
  vectorLiteral,
} from "./utils";
export async function indexChunks(ownerId: string, input: unknown) {
  assertOwner(ownerId);
  const data = schemas.indexChunksSchema.parse(input);
  assertEmbeddingModel(data.embeddingModel, true);
  if (data.chunkerVersion !== CHUNKER_VERSION)
    throw new BrainError(
      "CHUNKER_VERSION_MISMATCH",
      "Fetch pending_embeddings again to use the current chunking procedure.",
    );
  return transaction(async (db) => {
    const page = await rowForRef(db, ownerId, data.ref, true);
    assertVersion(page.version, data.expectedVersion);
    const chunks = chunkPage(page);
    const hashes = new Set(chunks.map((chunk) => chunk.contentHash));
    const supplied = new Map<string, string>();
    for (const item of data.embeddings) {
      if (!hashes.has(item.contentHash) || supplied.has(item.contentHash))
        throw new BrainError(
          "INVALID_CHUNK_MANIFEST",
          "Submit each requested contentHash at most once, using the current pending_embeddings manifest.",
        );
      supplied.set(item.contentHash, vectorLiteral(item.embedding));
    }
    const reusable = await db.query<{
      content_hash: string;
      embedding: string;
    }>(
      `SELECT DISTINCT ON (content_hash) content_hash,embedding::text FROM brain_page_chunks
       WHERE owner_id=$1 AND page_id=$2 AND embedding_model=$3 AND content_hash=ANY($4::text[])
       ORDER BY content_hash,page_version DESC`,
      [ownerId, page.id, data.embeddingModel, [...hashes]],
    );
    const available = new Map(
      reusable.rows.map((row) => [row.content_hash, row.embedding]),
    );
    for (const [hash, embedding] of supplied) available.set(hash, embedding);
    const populated = chunks.filter((chunk) =>
      available.has(chunk.contentHash),
    );
    const staged = await db.query<{ chunk_index: number }>(
      `SELECT chunk_index FROM brain_page_chunks WHERE owner_id=$1 AND page_id=$2
       AND page_version=$3 AND embedding_model=$4 AND chunker_version=$5`,
      [ownerId, page.id, page.version, data.embeddingModel, CHUNKER_VERSION],
    );
    const stagedIndices = new Set(staged.rows.map((row) => row.chunk_index));
    const newlyPopulated = populated.filter(
      (chunk) => !stagedIndices.has(chunk.index),
    );
    if (newlyPopulated.length) {
      await db.query(
        `INSERT INTO brain_page_chunks (owner_id,page_id,page_version,embedding_model,chunker_version,
          chunk_index,content_hash,content,start_offset,end_offset,token_count,embedding)
         SELECT $1,$2,$3,$4,$5,x.chunk_index,x.content_hash,x.content,x.start_offset,x.end_offset,x.token_count,x.embedding::vector
         FROM jsonb_to_recordset($6::jsonb) AS x(chunk_index integer,content_hash text,content text,
           start_offset integer,end_offset integer,token_count integer,embedding text)
         ON CONFLICT (owner_id,page_id,page_version,embedding_model,chunker_version,chunk_index)
         DO NOTHING`,
        [
          ownerId,
          page.id,
          page.version,
          data.embeddingModel,
          CHUNKER_VERSION,
          JSON.stringify(
            newlyPopulated.map((chunk) => ({
              chunk_index: chunk.index,
              content_hash: chunk.contentHash,
              content: chunk.content,
              start_offset: chunk.startOffset,
              end_offset: chunk.endOffset,
              token_count: chunk.tokenCount,
              embedding: available.get(chunk.contentHash),
            })),
          ),
        ],
      );
    }
    const indexed = populated.length === chunks.length;
    if (indexed) {
      const published = await db.query(
        `UPDATE brain_pages SET chunk_index_version=version,chunk_index_model=$3,
         chunk_index_chunker=$4,chunk_indexed_at=now() WHERE owner_id=$1 AND id=$2
         AND ${pendingEmbeddingsSql("", 3, 4)} RETURNING id`,
        [ownerId, page.id, data.embeddingModel, CHUNKER_VERSION],
      );
      await db.query(
        `DELETE FROM brain_page_chunks WHERE owner_id=$1 AND page_id=$2
         AND (page_version<>$3 OR embedding_model<>$4 OR chunker_version<>$5)`,
        [ownerId, page.id, page.version, data.embeddingModel, CHUNKER_VERSION],
      );
      if (published.rowCount)
        await db.query(
          `INSERT INTO brain_activity (owner_id,page_id,action,version,reason,source)
         VALUES ($1,$2,'embed',$3,$4,$5)`,
          [
            ownerId,
            page.id,
            page.version,
            `Indexed all ${chunks.length} page sections`,
            data.embeddingModel,
          ],
        );
    }
    return {
      id: page.id,
      version: page.version,
      embeddingModel: data.embeddingModel,
      chunkerVersion: CHUNKER_VERSION,
      indexed,
      totalChunks: chunks.length,
      indexedChunks: populated.length,
      pendingChunks: chunks.length - populated.length,
      reusedChunks: populated.filter(
        (chunk) => !supplied.has(chunk.contentHash),
      ).length,
    };
  });
}

export async function listPendingEmbeddings(
  ownerId: string,
  limit = 50,
  chunkLimit?: number,
) {
  assertOwner(ownerId);
  const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const result = await getPool().query<PageRow>(
    `SELECT ${PAGE_COLUMNS},p.markdown FROM brain_pages p WHERE p.owner_id=$1
    AND ${pendingEmbeddingsSql("p", 2, 4)} ORDER BY p.updated_at ASC,p.id LIMIT $3`,
    [ownerId, embeddingModel(), boundedLimit, CHUNKER_VERSION],
  );
  const reusable = result.rows.length
    ? await getPool().query<{ page_id: string; content_hash: string }>(
        `SELECT DISTINCT page_id,content_hash FROM brain_page_chunks
     WHERE owner_id=$1 AND page_id=ANY($2::uuid[]) AND embedding_model=$3`,
        [ownerId, result.rows.map((row) => row.id), embeddingModel()],
      )
    : { rows: [] };
  const available = new Set(
    reusable.rows.map((row) => `${row.page_id}:${row.content_hash}`),
  );
  return result.rows.map((row) => {
    const chunks = chunkPage(row).map((chunk) => ({
      ...chunk,
      needsEmbedding: !available.has(`${row.id}:${chunk.contentHash}`),
    }));
    const missing = [
      ...new Map(
        chunks
          .filter((chunk) => chunk.needsEmbedding)
          .map((chunk) => [chunk.contentHash, chunk]),
      ).values(),
    ];
    return {
      ...summary(row),
      ...(chunkLimit === undefined ? { markdown: row.markdown } : {}),
      embeddingModel: embeddingModel(),
      chunkerVersion: CHUNKER_VERSION,
      totalChunks: chunks.length,
      pendingChunks: missing.length,
      chunks:
        chunkLimit === undefined
          ? chunks
          : missing.slice(0, Math.min(32, Math.max(1, Math.floor(chunkLimit)))),
    };
  });
}
