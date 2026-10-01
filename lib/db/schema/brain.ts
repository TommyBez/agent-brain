import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { LINK_TYPES, MAX_PAGE_CHARACTERS, PAGE_TYPES } from "../../brain/types";
import { user } from "./auth";
import { oneOf } from "./checks";

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const brainLinks = pgTable(
  "brain_links",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    ownerId: text("owner_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    targetId: uuid("target_id").notNull(),
    type: text().notNull(),
    label: text().default("").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("brain_links_target_idx").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.targetId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.ownerId, table.sourceId],
      foreignColumns: [brainPages.ownerId, brainPages.id],
      name: "brain_links_owner_id_source_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.ownerId, table.targetId],
      foreignColumns: [brainPages.ownerId, brainPages.id],
      name: "brain_links_owner_id_target_id_fkey",
    }).onDelete("cascade"),
    unique("brain_links_owner_id_source_id_target_id_type_key").on(
      table.ownerId,
      table.sourceId,
      table.targetId,
      table.type,
    ),
    check("brain_links_type_check", oneOf(table.type, LINK_TYPES)),
    check("brain_links_check", sql`source_id <> target_id`),
  ],
);

export const brainPages = pgTable(
  "brain_pages",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    ownerId: text("owner_id").notNull(),
    slug: text().notNull(),
    type: text().notNull(),
    title: text().notNull(),
    summary: text().default("").notNull(),
    markdown: text().notNull(),
    aliases: text().array().default(sql`'{}'::text[]`).notNull(),
    tags: text().array().default(sql`'{}'::text[]`).notNull(),
    version: integer().default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    searchDocument: tsvector("search_document").generatedAlwaysAs(
      sql`((setweight(to_tsvector('simple'::regconfig, title), 'A'::"char") || setweight(to_tsvector('simple'::regconfig, summary), 'B'::"char")) || setweight(to_tsvector('simple'::regconfig, markdown), 'C'::"char"))`,
    ),
    chunkIndexVersion: integer("chunk_index_version"),
    chunkIndexModel: text("chunk_index_model"),
    chunkIndexChunker: text("chunk_index_chunker"),
    chunkIndexedAt: timestamp("chunk_indexed_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => [
    index("brain_pages_owner_type_idx").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.type.asc().nullsLast(),
    ),
    index("brain_pages_owner_updated_idx").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.updatedAt.desc().nullsFirst(),
    ),
    index("brain_pages_search_idx").using(
      "gin",
      table.searchDocument.asc().nullsLast().op("tsvector_ops"),
    ),
    index("brain_pages_title_trgm_idx").using(
      "gin",
      table.title.asc().nullsLast().op("gin_trgm_ops"),
    ),
    unique("brain_pages_owner_id_slug_key").on(table.ownerId, table.slug),
    unique("brain_pages_owner_id_id_key").on(table.ownerId, table.id),
    unique("brain_pages_owner_id_id_type_key").on(
      table.ownerId,
      table.id,
      table.type,
    ),
    check(
      "brain_pages_slug_check",
      sql`(char_length(slug) >= 1) AND (char_length(slug) <= 200)`,
    ),
    check("brain_pages_type_check", oneOf(table.type, PAGE_TYPES)),
    check(
      "brain_pages_title_check",
      sql`(char_length(title) >= 1) AND (char_length(title) <= 200)`,
    ),
    check(
      "brain_pages_markdown_check",
      sql`(char_length(markdown) >= 1) AND (char_length(markdown) <= ${sql.raw(String(MAX_PAGE_CHARACTERS))})`,
    ),
    check("brain_pages_version_check", sql`version > 0`),
    check(
      "brain_pages_chunk_index_state",
      sql`((chunk_index_version IS NULL) AND (chunk_index_model IS NULL) AND (chunk_index_chunker IS NULL) AND (chunk_indexed_at IS NULL)) OR ((chunk_index_version > 0) AND (chunk_index_version <= version) AND (chunk_index_model IS NOT NULL) AND (chunk_index_chunker IS NOT NULL) AND (chunk_indexed_at IS NOT NULL))`,
    ),
  ],
);

export const brainRevisions = pgTable(
  "brain_revisions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    ownerId: text("owner_id").notNull(),
    pageId: uuid("page_id").notNull(),
    version: integer().notNull(),
    snapshot: jsonb().notNull(),
    reason: text().notNull(),
    source: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    operationKey: text("operation_key"),
  },
  (table) => [
    uniqueIndex("brain_revisions_operation_key_idx")
      .using(
        "btree",
        table.ownerId.asc().nullsLast(),
        table.operationKey.asc().nullsLast(),
      )
      .where(sql`(operation_key IS NOT NULL)`),
    index("brain_revisions_owner_created_idx").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.createdAt.desc().nullsFirst(),
    ),
    foreignKey({
      columns: [table.ownerId, table.pageId],
      foreignColumns: [brainPages.ownerId, brainPages.id],
      name: "brain_revisions_owner_id_page_id_fkey",
    }).onDelete("cascade"),
    unique("brain_revisions_owner_id_page_id_version_key").on(
      table.ownerId,
      table.pageId,
      table.version,
    ),
    check(
      "brain_revisions_operation_key_check",
      sql`(operation_key IS NULL) OR ((char_length(operation_key) >= 1) AND (char_length(operation_key) <= 256))`,
    ),
  ],
);

export const brainActivity = pgTable(
  "brain_activity",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    ownerId: text("owner_id").notNull(),
    pageId: uuid("page_id").notNull(),
    action: text().notNull(),
    version: integer().notNull(),
    reason: text().notNull(),
    source: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("brain_activity_owner_created_idx").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.createdAt.desc().nullsFirst(),
    ),
    foreignKey({
      columns: [table.ownerId, table.pageId],
      foreignColumns: [brainPages.ownerId, brainPages.id],
      name: "brain_activity_owner_id_page_id_fkey",
    }).onDelete("cascade"),
    check(
      "brain_activity_action_check",
      oneOf(table.action, ["create", "write", "append", "embed"]),
    ),
  ],
);

export const agentTokens = pgTable(
  "agent_tokens",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    ownerId: text("owner_id").notNull(),
    name: text().notNull(),
    prefix: text().notNull(),
    tokenHash: text("token_hash").notNull(),
    scopes: text().array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    lastUsedAt: timestamp("last_used_at", {
      withTimezone: true,
      mode: "string",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    index("agent_tokens_owner_idx").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.createdAt.desc().nullsFirst(),
    ),
    foreignKey({
      columns: [table.ownerId],
      foreignColumns: [user.id],
      name: "agent_tokens_owner_id_fkey",
    }).onDelete("cascade"),
    unique("agent_tokens_token_hash_key").on(table.tokenHash),
    check(
      "agent_tokens_name_check",
      sql`(char_length(name) >= 1) AND (char_length(name) <= 80)`,
    ),
    check("agent_tokens_token_hash_check", sql`char_length(token_hash) = 64`),
    check(
      "agent_tokens_scopes_check",
      sql`(cardinality(scopes) > 0) AND (scopes <@ ARRAY['brain:read'::text, 'brain:write'::text, 'brain:maintain'::text])`,
    ),
  ],
);

export const brainJobs = pgTable(
  "brain_jobs",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    ownerId: text("owner_id").notNull(),
    kind: text().notNull(),
    runDate: date("run_date").default(sql`CURRENT_DATE`).notNull(),
    status: text().default("queued").notNull(),
    attempts: integer().default(0).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    finishedAt: timestamp("finished_at", {
      withTimezone: true,
      mode: "string",
    }),
    error: text(),
    result: jsonb(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    workflowRunId: text("workflow_run_id"),
  },
  (table) => [
    index("brain_jobs_pending_idx").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.status.asc().nullsLast(),
      table.createdAt.asc().nullsLast(),
    ),
    unique("brain_jobs_owner_id_kind_run_date_key").on(
      table.ownerId,
      table.kind,
      table.runDate,
    ),
    check(
      "brain_jobs_workflow_run_id_check",
      sql`(workflow_run_id IS NULL) OR ((char_length(workflow_run_id) >= 1) AND (char_length(workflow_run_id) <= 256))`,
    ),
    check(
      "brain_jobs_kind_check",
      oneOf(table.kind, ["consolidation", "embeddings", "export"]),
    ),
    check(
      "brain_jobs_status_check",
      oneOf(table.status, [
        "queued",
        "running",
        "succeeded",
        "partial",
        "failed",
      ]),
    ),
  ],
);

// Operational snapshots, judgments and atomic application receipts. These rows
// never enter brain_pages, graph retrieval or the knowledge embedding index.
export const brainConsolidationRecords = pgTable(
  "brain_consolidation_records",
  {
    ownerId: text("owner_id").notNull(),
    runId: text("run_id").notNull(),
    kind: text().notNull(),
    recordKey: text("record_key").notNull(),
    payload: jsonb().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.ownerId, table.runId, table.kind, table.recordKey],
      name: "brain_consolidation_records_pkey",
    }),
    index("brain_consolidation_records_cache_idx")
      .using(
        "btree",
        table.ownerId.asc().nullsLast(),
        table.recordKey.asc().nullsLast(),
        table.createdAt.desc().nullsFirst(),
        table.runId.desc().nullsFirst(),
      )
      .where(sql`kind = 'record'`),
    check(
      "brain_consolidation_records_kind_check",
      oneOf(table.kind, ["record", "receipt"]),
    ),
    check(
      "brain_consolidation_records_run_id_check",
      sql`char_length(run_id) BETWEEN 1 AND 256`,
    ),
    check(
      "brain_consolidation_records_record_key_check",
      sql`char_length(record_key) BETWEEN 1 AND 256`,
    ),
  ],
);

export const brainIdentities = pgTable(
  "brain_identities",
  {
    ownerId: text("owner_id").notNull(),
    pageId: uuid("page_id").notNull(),
    type: text().notNull(),
    identityKey: text("identity_key").notNull(),
  },
  (table) => [
    index("brain_identities_page_idx").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.pageId.asc().nullsLast(),
    ),
    index("brain_identities_trgm_idx").using(
      "gin",
      table.identityKey.asc().nullsLast().op("gin_trgm_ops"),
    ),
    foreignKey({
      columns: [table.ownerId, table.pageId, table.type],
      foreignColumns: [brainPages.ownerId, brainPages.id, brainPages.type],
      name: "brain_identities_owner_id_page_id_type_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.ownerId, table.type, table.identityKey],
      name: "brain_identities_pkey",
    }),
  ],
);

export const brainPageChunks = pgTable(
  "brain_page_chunks",
  {
    ownerId: text("owner_id").notNull(),
    pageId: uuid("page_id").notNull(),
    pageVersion: integer("page_version").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    chunkerVersion: text("chunker_version").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    contentHash: text("content_hash").notNull(),
    content: text().notNull(),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    tokenCount: integer("token_count").notNull(),
    embedding: vector({ dimensions: 1536 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("brain_page_chunks_embedding_idx").using(
      "hnsw",
      table.embedding.asc().nullsLast().op("vector_cosine_ops"),
    ),
    index("brain_page_chunks_reuse_idx").using(
      "btree",
      table.ownerId.asc().nullsLast(),
      table.pageId.asc().nullsLast(),
      table.embeddingModel.asc().nullsLast(),
      table.contentHash.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.ownerId, table.pageId],
      foreignColumns: [brainPages.ownerId, brainPages.id],
      name: "brain_page_chunks_owner_id_page_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [
        table.ownerId,
        table.pageId,
        table.pageVersion,
        table.embeddingModel,
        table.chunkerVersion,
        table.chunkIndex,
      ],
      name: "brain_page_chunks_pkey",
    }),
    check("brain_page_chunks_page_version_check", sql`page_version > 0`),
    check("brain_page_chunks_chunk_index_check", sql`chunk_index >= 0`),
    check(
      "brain_page_chunks_content_hash_check",
      sql`content_hash ~ '^[a-f0-9]{64}$'::text`,
    ),
    check("brain_page_chunks_start_offset_check", sql`start_offset >= 0`),
    check("brain_page_chunks_check", sql`end_offset >= start_offset`),
    check("brain_page_chunks_token_count_check", sql`token_count > 0`),
  ],
);

export const brainConsolidationSpend = pgTable(
  "brain_consolidation_spend",
  {
    id: uuid().defaultRandom().primaryKey(),
    ownerId: text("owner_id").notNull(),
    runId: text("run_id").notNull(),
    model: text().notNull(),
    day: date().notNull(),
    actualNano: bigint("actual_nano", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("brain_consolidation_spend_day_idx").on(table.day)],
);

export const brainConsolidationQueue = pgTable("brain_consolidation_queue", {
  ownerId: text("owner_id").primaryKey(),
  taskIds: jsonb("task_ids").$type<string[]>().notNull(),
});
