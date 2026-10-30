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
  real,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import {
  AGENT_CREATE_POLICIES,
  AGENT_KINDS,
  AGENT_LIMITS,
  OWNER_REVIEWED_OUTPUTS,
  SYSTEM_AGENT_KEYS,
  TASK_BLOCKED_REASONS,
  TASK_DUE_KINDS,
  TASK_EVENT_ACTIONS,
  TASK_EXPECTED_OUTPUTS,
  TASK_LIMITS,
  TASK_LINK_ORIGINS,
  TASK_LINK_ROLES,
  TASK_LINK_STATUSES,
  TASK_ORIGINS,
  TASK_PARTY_KINDS,
  TASK_PARTY_ROLES,
  TASK_RECURRENCE_KINDS,
  TASK_REVIEW_POLICIES,
  TASK_STATUSES,
  TASK_SUGGESTION_KINDS,
  TASK_SUGGESTION_STATUSES,
} from "../../tasks/types";
import { brainPages } from "./brain";
import { oneOf } from "./checks";

// Work state lives here, never in brain_pages: task rows, events and links do
// not enter page fingerprints, chunks, retrieval or the Git export.

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// Transaction id of the writer, so events_since never skips a slower commit.
const xid8 = customType<{ data: string }>({
  dataType() {
    return "xid8";
  },
});

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
};
const sha256 = (column: string) =>
  sql`(${sql.raw(column)} IS NULL) OR (${sql.raw(column)} ~ '^[a-f0-9]{64}$'::text)`;
const length = (column: string, min: number, max: number) =>
  sql`(${sql.raw(column)} IS NULL) OR (char_length(${sql.raw(column)}) BETWEEN ${sql.raw(String(min))} AND ${sql.raw(String(max))})`;
const quoted = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'::text`).join(", "));

export const brainAgents = pgTable(
  "brain_agents",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    ownerId: text("owner_id").notNull(),
    kind: text().notNull(),
    systemKey: text("system_key"),
    label: text().notNull(),
    // Token names and OAuth client names are self-declared until the owner edits them.
    labelVerified: boolean("label_verified").default(false).notNull(),
    capabilities: text().array().default(sql`'{}'::text[]`).notNull(),
    createPolicy: text("create_policy").default("triage").notNull(),
    trustedCreator: boolean("trusted_creator").default(false).notNull(),
    // NULL: true for OAuth requests, false for brain_ token requests.
    claimOnRequest: boolean("claim_on_request"),
    // The owner's (or an agent's) person page, e.g. person/tommaso-carnemolla.
    personPageId: uuid("person_page_id"),
    disabledAt: timestamp("disabled_at", {
      withTimezone: true,
      mode: "string",
    }),
    lastSeenAt: timestamp("last_seen_at", {
      withTimezone: true,
      mode: "string",
    }),
    ...timestamps,
  },
  (table) => [
    unique("brain_agents_owner_id_id_key").on(table.ownerId, table.id),
    uniqueIndex("brain_agents_owner_kind_idx")
      .on(table.ownerId)
      .where(sql`kind = 'owner'::text`),
    uniqueIndex("brain_agents_system_key_idx")
      .on(table.ownerId, table.systemKey)
      .where(sql`system_key IS NOT NULL`),
    // The migration narrows SET NULL to person_page_id.
    foreignKey({
      columns: [table.ownerId, table.personPageId],
      foreignColumns: [brainPages.ownerId, brainPages.id],
      name: "brain_agents_owner_id_person_page_id_fkey",
    }).onDelete("set null"),
    check("brain_agents_kind_check", oneOf(table.kind, AGENT_KINDS)),
    check(
      "brain_agents_system_key_check",
      sql`${oneOf(table.systemKey, SYSTEM_AGENT_KEYS)} AND ((kind = 'system'::text) = (system_key IS NOT NULL))`,
    ),
    check(
      "brain_agents_label_check",
      sql`char_length(label) BETWEEN 1 AND ${sql.raw(String(AGENT_LIMITS.label))}`,
    ),
    check(
      "brain_agents_capabilities_check",
      sql`(cardinality(capabilities) <= ${sql.raw(String(AGENT_LIMITS.capabilities))}) AND brain_text_elements_within(capabilities, ${sql.raw(String(AGENT_LIMITS.capability))})`,
    ),
    check(
      "brain_agents_create_policy_check",
      oneOf(table.createPolicy, AGENT_CREATE_POLICIES),
    ),
    check(
      "brain_agents_owner_state_check",
      sql`(kind <> 'owner'::text) OR (disabled_at IS NULL)`,
    ),
    check(
      "brain_agents_trusted_creator_check",
      sql`(kind = 'agent'::text) OR (NOT trusted_creator)`,
    ),
  ],
);

/** OAuth client_id → agent. A client id names software, not an installation. */
export const brainAgentClients = pgTable(
  "brain_agent_clients",
  {
    ownerId: text("owner_id").notNull(),
    clientId: text("client_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    firstSeenAt: timestamp("first_seen_at", {
      withTimezone: true,
      mode: "string",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.ownerId, table.clientId],
      name: "brain_agent_clients_pkey",
    }),
    index("brain_agent_clients_agent_idx").on(table.ownerId, table.agentId),
    foreignKey({
      columns: [table.ownerId, table.agentId],
      foreignColumns: [brainAgents.ownerId, brainAgents.id],
      name: "brain_agent_clients_owner_id_agent_id_fkey",
    }).onDelete("cascade"),
    check(
      "brain_agent_clients_client_id_check",
      sql`char_length(client_id) BETWEEN 1 AND ${sql.raw(String(AGENT_LIMITS.clientId))}`,
    ),
  ],
);

export const brainTasks = pgTable(
  "brain_tasks",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    ownerId: text("owner_id").notNull(),
    // Shown as T-<number>; assigned under an owner advisory lock.
    number: integer().notNull(),
    title: text().notNull(),
    description: text().default("").notNull(),
    acceptanceCriteria: text("acceptance_criteria")
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    expectedOutput: text("expected_output").default("none").notNull(),
    status: text().default("triage").notNull(),
    blockedReason: text("blocked_reason"),
    statusNote: text("status_note"),
    priority: smallint().default(2).notNull(),
    dueKind: text("due_kind").default("unset").notNull(),
    dueOn: date("due_on"),
    dueAt: timestamp("due_at", { withTimezone: true, mode: "string" }),
    dueText: text("due_text"),
    requiresHuman: boolean("requires_human").default(false).notNull(),
    reviewPolicy: text("review_policy").default("auto").notNull(),
    delegateAgentId: uuid("delegate_agent_id"),
    requiredCapability: text("required_capability"),
    projectPageId: uuid("project_page_id"),
    parentTaskId: uuid("parent_task_id"),
    origin: text().notNull(),
    ownerQuote: text("owner_quote"),
    createdByAgentId: uuid("created_by_agent_id").notNull(),
    approvedAt: timestamp("approved_at", {
      withTimezone: true,
      mode: "string",
    }),
    approvedByAgentId: uuid("approved_by_agent_id"),
    claimedByAgentId: uuid("claimed_by_agent_id"),
    // Secret fencing token: returned only by claim_task, never read back.
    leaseId: uuid("lease_id"),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "string" }),
    inputRequestedAt: timestamp("input_requested_at", {
      withTimezone: true,
      mode: "string",
    }),
    claimCount: integer("claim_count").default(0).notNull(),
    completion: jsonb(),
    completedLeaseHash: text("completed_lease_hash"),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    // Grows with content and owner status changes, never with claims or renewals.
    version: integer().default(1).notNull(),
    idempotencyKey: text("idempotency_key"),
    idempotencyFingerprint: text("idempotency_fingerprint"),
    searchDocument: tsvector("search_document").generatedAlwaysAs(
      sql`brain_task_search_document(title, acceptance_criteria, description)`,
    ),
    semanticFingerprint: text("semantic_fingerprint"),
    embedding: vector({ dimensions: 1536 }),
    embeddingModel: text("embedding_model"),
    // Task keeper extraction: source page@version and the item fingerprint.
    batchId: text("batch_id"),
    extractionFingerprint: text("extraction_fingerprint"),
    // Recurrence instances: at most one task per occurrence date.
    recurrenceId: uuid("recurrence_id"),
    occurrenceOn: date("occurrence_on"),
    archivedAt: timestamp("archived_at", {
      withTimezone: true,
      mode: "string",
    }),
    ...timestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("brain_tasks_owner_id_id_key").on(table.ownerId, table.id),
    unique("brain_tasks_owner_id_number_key").on(table.ownerId, table.number),
    index("brain_tasks_owner_status_idx").on(
      table.ownerId,
      table.status,
      table.priority,
      table.createdAt,
    ),
    index("brain_tasks_project_idx").on(
      table.ownerId,
      table.projectPageId,
      table.status,
    ),
    index("brain_tasks_lease_idx")
      .on(table.ownerId, table.leaseExpiresAt)
      .where(sql`lease_id IS NOT NULL`),
    index("brain_tasks_claimed_by_idx")
      .on(table.ownerId, table.claimedByAgentId)
      .where(sql`claimed_by_agent_id IS NOT NULL`),
    index("brain_tasks_parent_idx")
      .on(table.ownerId, table.parentTaskId)
      .where(sql`parent_task_id IS NOT NULL`),
    index("brain_tasks_search_idx").using(
      "gin",
      table.searchDocument.op("tsvector_ops"),
    ),
    index("brain_tasks_title_trgm_idx").using(
      "gin",
      table.title.op("gin_trgm_ops"),
    ),
    index("brain_tasks_batch_idx")
      .on(table.ownerId, table.batchId)
      .where(sql`batch_id IS NOT NULL`),
    uniqueIndex("brain_tasks_extraction_fingerprint_idx")
      .on(table.ownerId, table.extractionFingerprint)
      .where(sql`extraction_fingerprint IS NOT NULL`),
    unique("brain_tasks_recurrence_occurrence_key").on(
      table.ownerId,
      table.recurrenceId,
      table.occurrenceOn,
    ),
    uniqueIndex("brain_tasks_idempotency_idx")
      .on(table.ownerId, table.createdByAgentId, table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    foreignKey({
      columns: [table.ownerId, table.createdByAgentId],
      foreignColumns: [brainAgents.ownerId, brainAgents.id],
      name: "brain_tasks_owner_id_created_by_agent_id_fkey",
    }),
    foreignKey({
      columns: [table.ownerId, table.approvedByAgentId],
      foreignColumns: [brainAgents.ownerId, brainAgents.id],
      name: "brain_tasks_owner_id_approved_by_agent_id_fkey",
    }),
    foreignKey({
      columns: [table.ownerId, table.delegateAgentId],
      foreignColumns: [brainAgents.ownerId, brainAgents.id],
      name: "brain_tasks_owner_id_delegate_agent_id_fkey",
    }),
    foreignKey({
      columns: [table.ownerId, table.claimedByAgentId],
      foreignColumns: [brainAgents.ownerId, brainAgents.id],
      name: "brain_tasks_owner_id_claimed_by_agent_id_fkey",
    }),
    // Two columns on purpose: a page that stops being a project keeps the link
    // (the service clears it on the next edit) instead of failing write().
    // The migration narrows SET NULL to project_page_id.
    foreignKey({
      columns: [table.ownerId, table.projectPageId],
      foreignColumns: [brainPages.ownerId, brainPages.id],
      name: "brain_tasks_owner_id_project_page_id_fkey",
    }).onDelete("set null"),
    // The migration narrows SET NULL to parent_task_id.
    foreignKey({
      columns: [table.ownerId, table.parentTaskId],
      foreignColumns: [table.ownerId, table.id],
      name: "brain_tasks_owner_id_parent_task_id_fkey",
    }).onDelete("set null"),
    // The migration narrows SET NULL to recurrence_id.
    foreignKey({
      columns: [table.ownerId, table.recurrenceId],
      foreignColumns: [brainTaskRecurrences.ownerId, brainTaskRecurrences.id],
      name: "brain_tasks_owner_id_recurrence_id_fkey",
    }).onDelete("set null"),
    check("brain_tasks_number_check", sql`number > 0`),
    check(
      "brain_tasks_title_check",
      sql`char_length(title) BETWEEN 1 AND ${sql.raw(String(TASK_LIMITS.title))}`,
    ),
    check(
      "brain_tasks_description_check",
      sql`char_length(description) <= ${sql.raw(String(TASK_LIMITS.description))}`,
    ),
    check(
      "brain_tasks_acceptance_criteria_check",
      sql`(cardinality(acceptance_criteria) <= ${sql.raw(String(TASK_LIMITS.acceptanceCriteria))}) AND brain_text_elements_within(acceptance_criteria, ${sql.raw(String(TASK_LIMITS.acceptanceCriterion))})`,
    ),
    check(
      "brain_tasks_expected_output_check",
      oneOf(table.expectedOutput, TASK_EXPECTED_OUTPUTS),
    ),
    check("brain_tasks_status_check", oneOf(table.status, TASK_STATUSES)),
    check(
      "brain_tasks_blocked_reason_check",
      sql`${oneOf(table.blockedReason, TASK_BLOCKED_REASONS)} AND ((status = 'blocked'::text) = (blocked_reason IS NOT NULL))`,
    ),
    check(
      "brain_tasks_status_note_check",
      length("status_note", 1, TASK_LIMITS.statusNote),
    ),
    check("brain_tasks_priority_check", sql`priority BETWEEN 0 AND 3`),
    check("brain_tasks_due_kind_check", oneOf(table.dueKind, TASK_DUE_KINDS)),
    check(
      "brain_tasks_due_text_check",
      length("due_text", 1, TASK_LIMITS.dueText),
    ),
    check(
      "brain_tasks_due_unset_check",
      sql`(due_kind <> 'unset'::text) OR ((due_on IS NULL) AND (due_at IS NULL))`,
    ),
    check(
      "brain_tasks_due_date_check",
      sql`(due_kind <> 'date'::text) OR ((due_on IS NOT NULL) AND (due_at IS NULL))`,
    ),
    check(
      "brain_tasks_due_datetime_check",
      sql`(due_kind <> 'datetime'::text) OR ((due_at IS NOT NULL) AND (due_on IS NULL))`,
    ),
    check(
      "brain_tasks_due_approximate_check",
      sql`(due_kind <> 'approximate'::text) OR ((due_text IS NOT NULL) AND (due_at IS NULL))`,
    ),
    check(
      "brain_tasks_due_event_check",
      sql`(due_kind <> 'event'::text) OR ((due_text IS NOT NULL) AND (due_at IS NULL))`,
    ),
    check(
      "brain_tasks_due_hard_check",
      sql`(due_kind <> 'hard'::text) OR (num_nonnulls(due_on, due_at) = 1)`,
    ),
    check(
      "brain_tasks_review_policy_check",
      sql`${oneOf(table.reviewPolicy, TASK_REVIEW_POLICIES)} AND ((expected_output <> ALL (ARRAY[${quoted(OWNER_REVIEWED_OUTPUTS)}])) OR (review_policy = 'owner'::text))`,
    ),
    check(
      "brain_tasks_required_capability_check",
      length("required_capability", 1, TASK_LIMITS.requiredCapability),
    ),
    check(
      "brain_tasks_parent_task_id_check",
      sql`parent_task_id IS NULL OR parent_task_id <> id`,
    ),
    check("brain_tasks_origin_check", oneOf(table.origin, TASK_ORIGINS)),
    check(
      "brain_tasks_owner_quote_check",
      length("owner_quote", 1, TASK_LIMITS.ownerQuote),
    ),
    check(
      "brain_tasks_approval_check",
      sql`(approved_at IS NULL) = (approved_by_agent_id IS NULL)`,
    ),
    check(
      "brain_tasks_claim_check",
      sql`(claimed_by_agent_id IS NULL) = (lease_id IS NULL)`,
    ),
    // A lease is held only while working (expiring) or waiting for the owner
    // (suspended, no expiry); needs_input always keeps the holder's lease.
    check(
      "brain_tasks_lease_check",
      sql`((lease_id IS NULL) AND (lease_expires_at IS NULL) AND (status <> 'needs_input'::text)) OR ((lease_id IS NOT NULL) AND (claimed_at IS NOT NULL) AND (((status = 'in_progress'::text) AND (lease_expires_at IS NOT NULL)) OR ((status = 'needs_input'::text) AND (lease_expires_at IS NULL) AND (input_requested_at IS NOT NULL))))`,
    ),
    check("brain_tasks_claim_count_check", sql`claim_count >= 0`),
    check(
      "brain_tasks_completion_check",
      sql`(completion IS NULL) OR (jsonb_typeof(completion) = 'object'::text)`,
    ),
    check(
      "brain_tasks_completed_lease_hash_check",
      sha256("completed_lease_hash"),
    ),
    check("brain_tasks_version_check", sql`version > 0`),
    check(
      "brain_tasks_idempotency_check",
      sql`((idempotency_key IS NULL) = (idempotency_fingerprint IS NULL)) AND ((idempotency_key IS NULL) OR (char_length(idempotency_key) BETWEEN ${sql.raw(String(TASK_LIMITS.idempotencyKeyMin))} AND ${sql.raw(String(TASK_LIMITS.idempotencyKeyMax))})) AND (${sha256("idempotency_fingerprint")})`,
    ),
    check(
      "brain_tasks_extraction_check",
      sql`(${length("batch_id", 1, TASK_LIMITS.batchId)}) AND (${sha256("extraction_fingerprint")})`,
    ),
    check(
      "brain_tasks_recurrence_check",
      sql`(recurrence_id IS NULL) OR (occurrence_on IS NOT NULL)`,
    ),
    check(
      "brain_tasks_embedding_check",
      sql`((embedding IS NULL) = (embedding_model IS NULL)) AND ((embedding IS NULL) OR (semantic_fingerprint IS NOT NULL)) AND (${sha256("semantic_fingerprint")}) AND (${length("embedding_model", 1, TASK_LIMITS.embeddingModel)})`,
    ),
  ],
);

export const brainTaskEvents = pgTable(
  "brain_task_events",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    ownerId: text("owner_id").notNull(),
    // NULL only for `purged`, which outlives the deleted task.
    taskId: uuid("task_id"),
    actorAgentId: uuid("actor_agent_id").notNull(),
    action: text().notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    note: text(),
    // Never the lease_id.
    payload: jsonb().default(sql`'{}'::jsonb`).notNull(),
    ...timestamps,
    tx: xid8().default(sql`pg_current_xact_id()`).notNull(),
  },
  (table) => [
    index("brain_task_events_task_idx").on(
      table.ownerId,
      table.taskId,
      table.id,
    ),
    index("brain_task_events_owner_idx").on(table.ownerId, table.id),
    foreignKey({
      columns: [table.ownerId, table.taskId],
      foreignColumns: [brainTasks.ownerId, brainTasks.id],
      name: "brain_task_events_owner_id_task_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.ownerId, table.actorAgentId],
      foreignColumns: [brainAgents.ownerId, brainAgents.id],
      name: "brain_task_events_owner_id_actor_agent_id_fkey",
    }),
    check(
      "brain_task_events_action_check",
      sql`${oneOf(table.action, TASK_EVENT_ACTIONS)} AND ((task_id IS NULL) = (action = 'purged'::text))`,
    ),
    check(
      "brain_task_events_status_check",
      sql`${oneOf(table.fromStatus, TASK_STATUSES)} AND ${oneOf(table.toStatus, TASK_STATUSES)}`,
    ),
    check(
      "brain_task_events_note_check",
      length("note", 1, TASK_LIMITS.eventNote),
    ),
    check(
      "brain_task_events_payload_check",
      sql`jsonb_typeof(payload) = 'object'::text`,
    ),
  ],
);

export const brainTaskLinks = pgTable(
  "brain_task_links",
  {
    ownerId: text("owner_id").notNull(),
    taskId: uuid("task_id").notNull(),
    pageId: uuid("page_id").notNull(),
    role: text().notNull(),
    origin: text().notNull(),
    status: text().notNull(),
    confidence: real(),
    evidence: jsonb().default(sql`'{}'::jsonb`).notNull(),
    createdByAgentId: uuid("created_by_agent_id").notNull(),
    decidedByAgentId: uuid("decided_by_agent_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
    ...timestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.ownerId, table.taskId, table.pageId, table.role],
      name: "brain_task_links_pkey",
    }),
    index("brain_task_links_page_idx").on(
      table.ownerId,
      table.pageId,
      table.status,
    ),
    foreignKey({
      columns: [table.ownerId, table.taskId],
      foreignColumns: [brainTasks.ownerId, brainTasks.id],
      name: "brain_task_links_owner_id_task_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.ownerId, table.pageId],
      foreignColumns: [brainPages.ownerId, brainPages.id],
      name: "brain_task_links_owner_id_page_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.ownerId, table.createdByAgentId],
      foreignColumns: [brainAgents.ownerId, brainAgents.id],
      name: "brain_task_links_owner_id_created_by_agent_id_fkey",
    }),
    foreignKey({
      columns: [table.ownerId, table.decidedByAgentId],
      foreignColumns: [brainAgents.ownerId, brainAgents.id],
      name: "brain_task_links_owner_id_decided_by_agent_id_fkey",
    }),
    check("brain_task_links_role_check", oneOf(table.role, TASK_LINK_ROLES)),
    check(
      "brain_task_links_origin_check",
      oneOf(table.origin, TASK_LINK_ORIGINS),
    ),
    check(
      "brain_task_links_status_check",
      oneOf(table.status, TASK_LINK_STATUSES),
    ),
    check(
      "brain_task_links_confidence_check",
      sql`(confidence IS NULL) OR (confidence BETWEEN 0 AND 1)`,
    ),
    check(
      "brain_task_links_evidence_check",
      sql`jsonb_typeof(evidence) = 'object'::text`,
    ),
    check(
      "brain_task_links_decision_check",
      sql`(decided_at IS NULL) = (decided_by_agent_id IS NULL)`,
    ),
  ],
);

export const brainTaskParties = pgTable(
  "brain_task_parties",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    ownerId: text("owner_id").notNull(),
    taskId: uuid("task_id").notNull(),
    role: text().notNull(),
    kind: text().notNull(),
    agentId: uuid("agent_id"),
    personPageId: uuid("person_page_id"),
    groupLabel: text("group_label"),
    sourceNote: text("source_note"),
    createdByAgentId: uuid("created_by_agent_id").notNull(),
    ...timestamps,
  },
  (table) => [
    unique("brain_task_parties_member_key")
      .on(
        table.ownerId,
        table.taskId,
        table.role,
        table.agentId,
        table.personPageId,
        table.groupLabel,
      )
      .nullsNotDistinct(),
    index("brain_task_parties_task_idx").on(
      table.ownerId,
      table.taskId,
      table.role,
    ),
    foreignKey({
      columns: [table.ownerId, table.taskId],
      foreignColumns: [brainTasks.ownerId, brainTasks.id],
      name: "brain_task_parties_owner_id_task_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.ownerId, table.agentId],
      foreignColumns: [brainAgents.ownerId, brainAgents.id],
      name: "brain_task_parties_owner_id_agent_id_fkey",
    }),
    foreignKey({
      columns: [table.ownerId, table.personPageId],
      foreignColumns: [brainPages.ownerId, brainPages.id],
      name: "brain_task_parties_owner_id_person_page_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.ownerId, table.createdByAgentId],
      foreignColumns: [brainAgents.ownerId, brainAgents.id],
      name: "brain_task_parties_owner_id_created_by_agent_id_fkey",
    }),
    check("brain_task_parties_role_check", oneOf(table.role, TASK_PARTY_ROLES)),
    check("brain_task_parties_kind_check", oneOf(table.kind, TASK_PARTY_KINDS)),
    check(
      "brain_task_parties_member_check",
      sql`(num_nonnulls(agent_id, person_page_id, group_label) = 1) AND ((kind = ANY (ARRAY['owner'::text, 'agent'::text])) = (agent_id IS NOT NULL)) AND ((kind = 'person'::text) = (person_page_id IS NOT NULL)) AND ((kind = 'group'::text) = (group_label IS NOT NULL))`,
    ),
    check(
      "brain_task_parties_group_label_check",
      length("group_label", 1, TASK_LIMITS.partyGroupLabel),
    ),
    check(
      "brain_task_parties_source_note_check",
      length("source_note", 1, TASK_LIMITS.partySourceNote),
    ),
  ],
);

/** One row per owner: task keeper exclusions, paused projects and saved views. */
export const brainTaskSettings = pgTable(
  "brain_task_settings",
  {
    ownerId: text("owner_id").primaryKey().notNull(),
    /** The owner's task manager switch; off until the owner turns it on. */
    enabled: boolean("enabled").default(false).notNull(),
    keeperExcludedPageIds: uuid("keeper_excluded_page_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    pausedProjectIds: uuid("paused_project_ids")
      .array()
      .default(sql`'{}'::uuid[]`)
      .notNull(),
    savedViews: jsonb("saved_views").default(sql`'[]'::jsonb`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  () => [
    check(
      "brain_task_settings_saved_views_check",
      sql`jsonb_typeof(saved_views) = 'array'::text`,
    ),
  ],
);

/** Rejected extractions never return; matched by fingerprint. */
export const brainTaskExtractionRejections = pgTable(
  "brain_task_extraction_rejections",
  {
    ownerId: text("owner_id").notNull(),
    fingerprint: text().notNull(),
    sourcePageId: uuid("source_page_id"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.ownerId, table.fingerprint],
      name: "brain_task_extraction_rejections_pkey",
    }),
    // The migration narrows SET NULL to source_page_id.
    foreignKey({
      columns: [table.ownerId, table.sourcePageId],
      foreignColumns: [brainPages.ownerId, brainPages.id],
      name: "brain_task_extraction_rejections_owner_id_source_page_id_fkey",
    }).onDelete("set null"),
    check(
      "brain_task_extraction_rejections_fingerprint_check",
      sql`fingerprint ~ '^[a-f0-9]{64}$'::text`,
    ),
  ],
);

/** Cited task keeper proposals; only the owner accepts or dismisses them. */
export const brainTaskSuggestions = pgTable(
  "brain_task_suggestions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    ownerId: text("owner_id").notNull(),
    taskId: uuid("task_id").notNull(),
    // The other task of a `duplicate` proposal.
    relatedTaskId: uuid("related_task_id"),
    kind: text().notNull(),
    status: text().default("open").notNull(),
    citations: jsonb().default(sql`'[]'::jsonb`).notNull(),
    confidence: real(),
    policyVersion: text("policy_version").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    // The prefilled transition the owner executes on acceptance.
    payload: jsonb().default(sql`'{}'::jsonb`).notNull(),
    createdByAgentId: uuid("created_by_agent_id").notNull(),
    decidedByAgentId: uuid("decided_by_agent_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
    ...timestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("brain_task_suggestions_owner_id_id_key").on(
      table.ownerId,
      table.id,
    ),
    unique("brain_task_suggestions_owner_id_dedupe_key_key").on(
      table.ownerId,
      table.dedupeKey,
    ),
    index("brain_task_suggestions_task_idx").on(
      table.ownerId,
      table.taskId,
      table.status,
    ),
    index("brain_task_suggestions_status_idx").on(
      table.ownerId,
      table.status,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.ownerId, table.taskId],
      foreignColumns: [brainTasks.ownerId, brainTasks.id],
      name: "brain_task_suggestions_owner_id_task_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.ownerId, table.relatedTaskId],
      foreignColumns: [brainTasks.ownerId, brainTasks.id],
      name: "brain_task_suggestions_owner_id_related_task_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.ownerId, table.createdByAgentId],
      foreignColumns: [brainAgents.ownerId, brainAgents.id],
      name: "brain_task_suggestions_owner_id_created_by_agent_id_fkey",
    }),
    foreignKey({
      columns: [table.ownerId, table.decidedByAgentId],
      foreignColumns: [brainAgents.ownerId, brainAgents.id],
      name: "brain_task_suggestions_owner_id_decided_by_agent_id_fkey",
    }),
    check(
      "brain_task_suggestions_kind_check",
      oneOf(table.kind, TASK_SUGGESTION_KINDS),
    ),
    check(
      "brain_task_suggestions_status_check",
      oneOf(table.status, TASK_SUGGESTION_STATUSES),
    ),
    check(
      "brain_task_suggestions_related_task_id_check",
      sql`(related_task_id IS NULL) OR (related_task_id <> task_id)`,
    ),
    check(
      "brain_task_suggestions_confidence_check",
      sql`(confidence IS NULL) OR (confidence BETWEEN 0 AND 1)`,
    ),
    check(
      "brain_task_suggestions_json_check",
      sql`(jsonb_typeof(citations) = 'array'::text) AND (jsonb_typeof(payload) = 'object'::text)`,
    ),
    check(
      "brain_task_suggestions_policy_version_check",
      sql`char_length(policy_version) BETWEEN 1 AND ${sql.raw(String(TASK_LIMITS.policyVersion))}`,
    ),
    check(
      "brain_task_suggestions_dedupe_key_check",
      sql`char_length(dedupe_key) BETWEEN 1 AND ${sql.raw(String(TASK_LIMITS.suggestionDedupeKey))}`,
    ),
    check(
      "brain_task_suggestions_decision_check",
      sql`(decided_at IS NULL) = (decided_by_agent_id IS NULL)`,
    ),
  ],
);

/** "A blocks B": task_id depends on depends_on_task_id. Cycles are rejected by the service. */
export const brainTaskDependencies = pgTable(
  "brain_task_dependencies",
  {
    ownerId: text("owner_id").notNull(),
    taskId: uuid("task_id").notNull(),
    dependsOnTaskId: uuid("depends_on_task_id").notNull(),
    createdByAgentId: uuid("created_by_agent_id").notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({
      columns: [table.ownerId, table.taskId, table.dependsOnTaskId],
      name: "brain_task_dependencies_pkey",
    }),
    index("brain_task_dependencies_depends_on_idx").on(
      table.ownerId,
      table.dependsOnTaskId,
    ),
    foreignKey({
      columns: [table.ownerId, table.taskId],
      foreignColumns: [brainTasks.ownerId, brainTasks.id],
      name: "brain_task_dependencies_owner_id_task_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.ownerId, table.dependsOnTaskId],
      foreignColumns: [brainTasks.ownerId, brainTasks.id],
      name: "brain_task_dependencies_owner_id_depends_on_task_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.ownerId, table.createdByAgentId],
      foreignColumns: [brainAgents.ownerId, brainAgents.id],
      name: "brain_task_dependencies_owner_id_created_by_agent_id_fkey",
    }),
    check("brain_task_dependencies_check", sql`task_id <> depends_on_task_id`),
  ],
);

/**
 * Owner templates with an RRULE. `task` series yield ready instances (created
 * by the task keeper); `meeting` series carry the meeting RRULE for the agenda.
 */
export const brainTaskRecurrences = pgTable(
  "brain_task_recurrences",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    ownerId: text("owner_id").notNull(),
    kind: text().default("task").notNull(),
    template: jsonb().notNull(),
    rrule: text().notNull(),
    nextAt: timestamp("next_at", { withTimezone: true, mode: "string" }),
    projectPageId: uuid("project_page_id"),
    pausedAt: timestamp("paused_at", { withTimezone: true, mode: "string" }),
    createdByAgentId: uuid("created_by_agent_id").notNull(),
    ...timestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("brain_task_recurrences_owner_id_id_key").on(
      table.ownerId,
      table.id,
    ),
    index("brain_task_recurrences_due_idx")
      .on(table.ownerId, table.nextAt)
      .where(sql`paused_at IS NULL`),
    // The migration narrows SET NULL to project_page_id.
    foreignKey({
      columns: [table.ownerId, table.projectPageId],
      foreignColumns: [brainPages.ownerId, brainPages.id],
      name: "brain_task_recurrences_owner_id_project_page_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.ownerId, table.createdByAgentId],
      foreignColumns: [brainAgents.ownerId, brainAgents.id],
      name: "brain_task_recurrences_owner_id_created_by_agent_id_fkey",
    }),
    check(
      "brain_task_recurrences_kind_check",
      oneOf(table.kind, TASK_RECURRENCE_KINDS),
    ),
    check(
      "brain_task_recurrences_template_check",
      sql`jsonb_typeof(template) = 'object'::text`,
    ),
    check(
      "brain_task_recurrences_rrule_check",
      sql`char_length(rrule) BETWEEN 1 AND ${sql.raw(String(TASK_LIMITS.rrule))}`,
    ),
  ],
);
