import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const user = pgTable(
  "user",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    email: text().notNull(),
    emailVerified: boolean().notNull(),
    image: text(),
    createdAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [unique("user_email_key").on(table.email)],
);

export const session = pgTable(
  "session",
  {
    id: text().primaryKey().notNull(),
    expiresAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    token: text().notNull(),
    createdAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    ipAddress: text(),
    userAgent: text(),
    userId: text().notNull(),
  },
  (table) => [
    index("session_userId_idx").using("btree", table.userId.asc().nullsLast()),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "session_userId_fkey",
    }).onDelete("cascade"),
    unique("session_token_key").on(table.token),
  ],
);

export const account = pgTable(
  "account",
  {
    id: text().primaryKey().notNull(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text().notNull(),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true, mode: "string" }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true, mode: "string" }),
    scope: text(),
    password: text(),
    createdAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    index("account_userId_idx").using("btree", table.userId.asc().nullsLast()),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "account_userId_fkey",
    }).onDelete("cascade"),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: text().primaryKey().notNull(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    createdAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    index("verification_identifier_idx").using(
      "btree",
      table.identifier.asc().nullsLast(),
    ),
  ],
);

export const jwks = pgTable("jwks", {
  id: text().primaryKey().notNull(),
  publicKey: text().notNull(),
  privateKey: text().notNull(),
  createdAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
  expiresAt: timestamp({ withTimezone: true, mode: "string" }),
  alg: text(),
  crv: text(),
});

export const oauthClient = pgTable(
  "oauthClient",
  {
    id: text().primaryKey().notNull(),
    clientId: text().notNull(),
    clientSecret: text(),
    clientDiscoveryId: text(),
    disabled: boolean(),
    skipConsent: boolean(),
    enableEndSession: boolean(),
    subjectType: text(),
    scopes: jsonb(),
    clientCredentialsScopes: jsonb(),
    userId: text(),
    createdAt: timestamp({ withTimezone: true, mode: "string" }),
    updatedAt: timestamp({ withTimezone: true, mode: "string" }),
    name: text(),
    uri: text(),
    icon: text(),
    contacts: jsonb(),
    tos: text(),
    policy: text(),
    softwareId: text(),
    softwareVersion: text(),
    softwareStatement: text(),
    redirectUris: jsonb().notNull(),
    postLogoutRedirectUris: jsonb(),
    backchannelLogoutUri: text(),
    backchannelLogoutSessionRequired: boolean(),
    tokenEndpointAuthMethod: text(),
    applicationType: text(),
    jwks: text(),
    jwksUri: text(),
    grantTypes: jsonb(),
    responseTypes: jsonb(),
    requirePkce: boolean("requirePKCE"),
    dpopBoundAccessTokens: boolean(),
    referenceId: text(),
    metadata: jsonb(),
  },
  (table) => [
    index("oauthClient_userId_idx").using(
      "btree",
      table.userId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "oauthClient_userId_fkey",
    }).onDelete("cascade"),
    unique("oauthClient_clientId_key").on(table.clientId),
  ],
);

export const oauthClientResource = pgTable(
  "oauthClientResource",
  {
    id: text().primaryKey().notNull(),
    clientId: text().notNull(),
    resourceId: text().notNull(),
    metadata: jsonb(),
    createdAt: timestamp({ withTimezone: true, mode: "string" }),
  },
  (table) => [
    index("oauthClientResource_clientId_idx").using(
      "btree",
      table.clientId.asc().nullsLast(),
    ),
    uniqueIndex("oauthClientResource_clientId_resourceId_uidx").using(
      "btree",
      table.clientId.asc().nullsLast(),
      table.resourceId.asc().nullsLast(),
    ),
    index("oauthClientResource_resourceId_idx").using(
      "btree",
      table.resourceId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.clientId],
      foreignColumns: [oauthClient.clientId],
      name: "oauthClientResource_clientId_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.resourceId],
      foreignColumns: [oauthResource.identifier],
      name: "oauthClientResource_resourceId_fkey",
    }).onDelete("cascade"),
  ],
);

export const oauthResource = pgTable(
  "oauthResource",
  {
    id: text().primaryKey().notNull(),
    identifier: text().notNull(),
    name: text().notNull(),
    accessTokenTtl: integer(),
    refreshTokenTtl: integer(),
    signingAlgorithm: text(),
    signingKeyId: text(),
    allowedScopes: jsonb(),
    customClaims: jsonb(),
    dpopBoundAccessTokensRequired: boolean(),
    disabled: boolean(),
    createdAt: timestamp({ withTimezone: true, mode: "string" }),
    updatedAt: timestamp({ withTimezone: true, mode: "string" }),
    policyVersion: integer(),
    metadata: jsonb(),
  },
  (table) => [unique("oauthResource_identifier_key").on(table.identifier)],
);

export const oauthRefreshToken = pgTable(
  "oauthRefreshToken",
  {
    id: text().primaryKey().notNull(),
    token: text().notNull(),
    clientId: text().notNull(),
    sessionId: text(),
    userId: text().notNull(),
    referenceId: text(),
    authorizationCodeId: text(),
    resources: jsonb(),
    requestedUserInfoClaims: jsonb(),
    expiresAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    createdAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    revoked: timestamp({ withTimezone: true, mode: "string" }),
    rotatedAt: timestamp({ withTimezone: true, mode: "string" }),
    rotationReplayResponse: text(),
    rotationReplayExpiresAt: timestamp({ withTimezone: true, mode: "string" }),
    authTime: timestamp({ withTimezone: true, mode: "string" }),
    confirmation: jsonb(),
    scopes: jsonb().notNull(),
  },
  (table) => [
    index("oauthRefreshToken_authorizationCodeId_idx").using(
      "btree",
      table.authorizationCodeId.asc().nullsLast(),
    ),
    index("oauthRefreshToken_clientId_idx").using(
      "btree",
      table.clientId.asc().nullsLast(),
    ),
    index("oauthRefreshToken_sessionId_idx").using(
      "btree",
      table.sessionId.asc().nullsLast(),
    ),
    index("oauthRefreshToken_userId_idx").using(
      "btree",
      table.userId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.clientId],
      foreignColumns: [oauthClient.clientId],
      name: "oauthRefreshToken_clientId_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [session.id],
      name: "oauthRefreshToken_sessionId_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "oauthRefreshToken_userId_fkey",
    }).onDelete("cascade"),
    unique("oauthRefreshToken_token_key").on(table.token),
  ],
);

export const oauthAccessToken = pgTable(
  "oauthAccessToken",
  {
    id: text().primaryKey().notNull(),
    token: text().notNull(),
    clientId: text().notNull(),
    sessionId: text(),
    userId: text(),
    referenceId: text(),
    authorizationCodeId: text(),
    resources: jsonb(),
    requestedUserInfoClaims: jsonb(),
    refreshId: text(),
    expiresAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    createdAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    revoked: timestamp({ withTimezone: true, mode: "string" }),
    confirmation: jsonb(),
    scopes: jsonb().notNull(),
  },
  (table) => [
    index("oauthAccessToken_authorizationCodeId_idx").using(
      "btree",
      table.authorizationCodeId.asc().nullsLast(),
    ),
    index("oauthAccessToken_clientId_idx").using(
      "btree",
      table.clientId.asc().nullsLast(),
    ),
    index("oauthAccessToken_refreshId_idx").using(
      "btree",
      table.refreshId.asc().nullsLast(),
    ),
    index("oauthAccessToken_sessionId_idx").using(
      "btree",
      table.sessionId.asc().nullsLast(),
    ),
    index("oauthAccessToken_userId_idx").using(
      "btree",
      table.userId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.clientId],
      foreignColumns: [oauthClient.clientId],
      name: "oauthAccessToken_clientId_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [session.id],
      name: "oauthAccessToken_sessionId_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "oauthAccessToken_userId_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.refreshId],
      foreignColumns: [oauthRefreshToken.id],
      name: "oauthAccessToken_refreshId_fkey",
    }).onDelete("cascade"),
    unique("oauthAccessToken_token_key").on(table.token),
  ],
);

export const oauthConsent = pgTable(
  "oauthConsent",
  {
    id: text().primaryKey().notNull(),
    clientId: text().notNull(),
    userId: text(),
    referenceId: text(),
    resources: jsonb(),
    requestedUserInfoClaims: jsonb(),
    scopes: jsonb().notNull(),
    createdAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    index("oauthConsent_clientId_idx").using(
      "btree",
      table.clientId.asc().nullsLast(),
    ),
    index("oauthConsent_userId_idx").using(
      "btree",
      table.userId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.clientId],
      foreignColumns: [oauthClient.clientId],
      name: "oauthConsent_clientId_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "oauthConsent_userId_fkey",
    }).onDelete("cascade"),
  ],
);

export const oauthClientAssertion = pgTable("oauthClientAssertion", {
  id: text().primaryKey().notNull(),
  expiresAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
});

export const rateLimit = pgTable(
  "rateLimit",
  {
    id: text().primaryKey().notNull(),
    key: text().notNull(),
    count: integer().notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    lastRequest: bigint({ mode: "number" }).notNull(),
  },
  (table) => [unique("rateLimit_key_key").on(table.key)],
);

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
    check(
      "brain_links_type_check",
      sql`type = ANY (ARRAY['works_at'::text, 'owns'::text, 'part_of'::text, 'relates_to'::text, 'decided_in'::text, 'references'::text, 'depends_on'::text, 'supersedes'::text, 'collaborates_with'::text])`,
    ),
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
    check(
      "brain_pages_type_check",
      sql`type = ANY (ARRAY['person'::text, 'client'::text, 'project'::text, 'article'::text, 'decision'::text, 'note'::text])`,
    ),
    check(
      "brain_pages_title_check",
      sql`(char_length(title) >= 1) AND (char_length(title) <= 200)`,
    ),
    check(
      "brain_pages_markdown_check",
      sql`(char_length(markdown) >= 1) AND (char_length(markdown) <= 200000)`,
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
      sql`action = ANY (ARRAY['create'::text, 'write'::text, 'append'::text, 'embed'::text])`,
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
      sql`kind = ANY (ARRAY['consolidation'::text, 'embeddings'::text, 'export'::text])`,
    ),
    check(
      "brain_jobs_status_check",
      sql`status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'partial'::text, 'failed'::text])`,
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
      sql`kind = ANY (ARRAY['record'::text, 'receipt'::text])`,
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
