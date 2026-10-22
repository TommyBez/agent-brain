// Shared task vocabulary. The database CHECK constraints are generated from
// these lists, so every value here is part of the persisted contract.

export const AGENT_KINDS = ["owner", "agent", "system"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const SYSTEM_AGENT_KEYS = ["consolidator", "task_keeper"] as const;
export type SystemAgentKey = (typeof SYSTEM_AGENT_KEYS)[number];
export const SYSTEM_AGENT_LABELS: Record<SystemAgentKey, string> = {
  consolidator: "Consolidator",
  task_keeper: "Task keeper",
};

/** `direct`: tasks start ready, but only for their creator (never approved). */
export const AGENT_CREATE_POLICIES = ["triage", "direct"] as const;
export type AgentCreatePolicy = (typeof AGENT_CREATE_POLICIES)[number];

/** How the current request authenticated; `system` is a nightly process. */
export const AGENT_CREDENTIALS = [
  "session",
  "token",
  "oauth",
  "system",
] as const;
export type AgentCredential = (typeof AGENT_CREDENTIALS)[number];

export const AGENT_LIMITS = {
  label: 80,
  capability: 100,
  capabilities: 50,
  clientId: 256,
} as const;
export const AGENT_LAST_SEEN_INTERVAL_MINUTES = 5;

export const TASK_STATUSES = [
  "triage",
  "ready",
  "in_progress",
  "needs_input",
  "blocked",
  "in_review",
  "on_hold",
  "done",
  "canceled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TERMINAL_TASK_STATUSES = [
  "done",
  "canceled",
] as const satisfies readonly TaskStatus[];
export const OPEN_TASK_STATUSES = [
  "triage",
  "ready",
  "in_progress",
  "needs_input",
  "blocked",
  "in_review",
  "on_hold",
] as const satisfies readonly TaskStatus[];
/** The only statuses that may carry a lease. */
export const LEASED_TASK_STATUSES = [
  "in_progress",
  "needs_input",
] as const satisfies readonly TaskStatus[];

export const TASK_BLOCKED_REASONS = [
  "dependency",
  "external",
  "human_step",
  "decision",
] as const;
export type TaskBlockedReason = (typeof TASK_BLOCKED_REASONS)[number];

/** 0 = urgent … 3 = low; lower numbers sort first. */
export const TASK_PRIORITIES = [0, 1, 2, 3] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const TASK_PRIORITY_LABELS = [
  "urgent",
  "high",
  "normal",
  "low",
] as const;
export const DEFAULT_TASK_PRIORITY: TaskPriority = 2;

/**
 * `date` → due_on; `datetime` → due_at; `approximate`/`event` → due_text
 * (with an optional estimated due_on); `hard` → exactly one of due_on/due_at;
 * `unset` → neither date. due_text keeps the original wording for any kind.
 */
export const TASK_DUE_KINDS = [
  "unset",
  "date",
  "datetime",
  "approximate",
  "event",
  "hard",
] as const;
export type TaskDueKind = (typeof TASK_DUE_KINDS)[number];

export const TASK_EXPECTED_OUTPUTS = [
  "none",
  "decision",
  "page",
  "artifact",
  "external_action",
] as const;
export type TaskExpectedOutput = (typeof TASK_EXPECTED_OUTPUTS)[number];

export const TASK_REVIEW_POLICIES = ["auto", "owner"] as const;
export type TaskReviewPolicy = (typeof TASK_REVIEW_POLICIES)[number];
/** These outputs are always closed by the owner (enforced by a CHECK). */
export const OWNER_REVIEWED_OUTPUTS = [
  "decision",
  "external_action",
] as const satisfies readonly TaskExpectedOutput[];

export function defaultReviewPolicy(
  expectedOutput: TaskExpectedOutput,
): TaskReviewPolicy {
  return (OWNER_REVIEWED_OUTPUTS as readonly string[]).includes(expectedOutput)
    ? "owner"
    : "auto";
}

export const TASK_ORIGINS = [
  "owner_ui",
  "owner_request",
  "owner_plan",
  "subtask",
  "handoff",
  "extracted",
  "recurrence",
] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];
/** Origins an agent may declare through create_task. */
export const AGENT_TASK_ORIGINS = [
  "owner_request",
  "owner_plan",
  "subtask",
  "handoff",
] as const satisfies readonly TaskOrigin[];

export const TASK_EVENT_ACTIONS = [
  "created",
  "edited",
  "approved",
  "delegated",
  "status_changed",
  "claimed",
  "reported",
  "asked",
  "answered",
  "released",
  "completed",
  "reviewed",
  "links_changed",
  "note",
  "purged",
] as const;
export type TaskEventAction = (typeof TASK_EVENT_ACTIONS)[number];

export const TASK_LINK_ROLES = [
  "context",
  "decision",
  "stakeholder",
  "source",
  "produced",
] as const;
export type TaskLinkRole = (typeof TASK_LINK_ROLES)[number];

export const TASK_LINK_ORIGINS = [
  "owner",
  "agent",
  "rule",
  "provenance",
  "consolidator",
  "task_keeper",
] as const;
export type TaskLinkOrigin = (typeof TASK_LINK_ORIGINS)[number];
/** Origins the conciliator may rewrite; every other origin is left untouched. */
export const MACHINE_TASK_LINK_ORIGINS = [
  "rule",
  "consolidator",
] as const satisfies readonly TaskLinkOrigin[];

export const TASK_LINK_STATUSES = [
  "suggested",
  "active",
  "rejected",
  "retracted",
] as const;
export type TaskLinkStatus = (typeof TASK_LINK_STATUSES)[number];

export const TASK_LINK_EVIDENCE_BASES = [
  "reference",
  "decided_in",
  "retrieval",
  "revision",
  "extraction",
  "jev",
] as const;
export type TaskLinkEvidenceBasis = (typeof TASK_LINK_EVIDENCE_BASES)[number];

export interface TaskLinkEvidence {
  pageVersion?: number;
  startOffset?: number;
  endOffset?: number;
  recordKey?: string;
  policyVersion?: string;
  basis?: TaskLinkEvidenceBasis;
}

export const TASK_PARTY_ROLES = [
  "lead",
  "support",
  "reviewer",
  "requester",
] as const;
export type TaskPartyRole = (typeof TASK_PARTY_ROLES)[number];

/** owner/agent → agent_id; person → person_page_id; group → group_label. */
export const TASK_PARTY_KINDS = ["owner", "agent", "person", "group"] as const;
export type TaskPartyKind = (typeof TASK_PARTY_KINDS)[number];
/** A lead of these kinds keeps a task out of queue claims. */
export const HUMAN_TASK_PARTY_KINDS = [
  "person",
  "group",
] as const satisfies readonly TaskPartyKind[];

export const TASK_SUGGESTION_KINDS = [
  "overdue_no_outcome",
  "stale_claim",
  "triage_aging",
  "decision_superseded",
  "new_source",
  "may_be_done",
  "criterion_evidence",
  "divergent_state",
  "duplicate",
] as const;
export type TaskSuggestionKind = (typeof TASK_SUGGESTION_KINDS)[number];
export const DETERMINISTIC_TASK_SUGGESTION_KINDS = [
  "overdue_no_outcome",
  "stale_claim",
  "triage_aging",
  "decision_superseded",
] as const satisfies readonly TaskSuggestionKind[];

export const TASK_SUGGESTION_STATUSES = [
  "open",
  "accepted",
  "dismissed",
  "expired",
] as const;
export type TaskSuggestionStatus = (typeof TASK_SUGGESTION_STATUSES)[number];

export const TASK_RECURRENCE_KINDS = ["task", "meeting"] as const;
export type TaskRecurrenceKind = (typeof TASK_RECURRENCE_KINDS)[number];

/** brain_consolidation_spend.purpose; existing rows and old code mean `pages`. */
export const SPEND_PURPOSES = ["pages", "task_keeper", "task_links"] as const;
export type SpendPurpose = (typeof SPEND_PURPOSES)[number];
/** Nightly phases added to brain_jobs.kind by this release. */
export const TASK_JOB_KINDS = ["task_keeper", "task_links"] as const;
export type TaskJobKind = (typeof TASK_JOB_KINDS)[number];

export const TASK_LIMITS = {
  title: 200,
  description: 20_000,
  acceptanceCriteria: 20,
  acceptanceCriterion: 500,
  statusNote: 2_000,
  dueText: 200,
  ownerQuote: 500,
  eventNote: 4_000,
  requiredCapability: 100,
  idempotencyKeyMin: 8,
  idempotencyKeyMax: 100,
  embeddingModel: 200,
  batchId: 300,
  partyGroupLabel: 120,
  partySourceNote: 300,
  suggestionDedupeKey: 256,
  policyVersion: 100,
  rrule: 1_000,
} as const;

export const LEASE_MINUTES = { default: 30, min: 5, max: 240 } as const;
/** Holders should report before this fraction of the lease has elapsed. */
export const REPORT_BY_FRACTION = 0.8;

/** Lowercase sha256 hex, the format of every stored fingerprint and hash. */
export const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface TaskCompletion {
  summary: string;
  criteria: {
    index: number;
    status: "met" | "partial" | "not_met";
    evidence: string;
    verification: "observed" | "self_reported";
  }[];
  artifacts: {
    kind: "pr" | "branch" | "commit" | "url" | "file";
    value: string;
  }[];
  remaining?: string;
  fingerprint: string;
}

const TASK_REF = /^T-([1-9]\d{0,9})$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function formatTaskRef(number: number): string {
  return `T-${number}`;
}

/** Accepts `T-42` (any case) or a task uuid; anything else is null. */
export function parseTaskRef(
  ref: string,
): { kind: "number"; number: number } | { kind: "id"; id: string } | null {
  const value = ref.trim();
  const match = TASK_REF.exec(value);
  if (match) {
    const number = Number(match[1]);
    return number <= 2_147_483_647 ? { kind: "number", number } : null;
  }
  return UUID.test(value) ? { kind: "id", id: value.toLowerCase() } : null;
}

/** brain_tasks.batch_id: the source page and version an extraction came from. */
export function taskBatchId(pageId: string, pageVersion: number): string {
  return `${pageId}@${pageVersion}`;
}

export function parseTaskBatchId(
  batchId: string,
): { pageId: string; pageVersion: number } | null {
  const at = batchId.lastIndexOf("@");
  const pageId = batchId.slice(0, at);
  const pageVersion = Number(batchId.slice(at + 1));
  return at > 0 && UUID.test(pageId) && Number.isInteger(pageVersion)
    ? { pageId, pageVersion }
    : null;
}

/**
 * Claim on explicit owner request: an owner override wins; otherwise chat
 * clients (OAuth) may and headless workers (tokens) may not.
 */
export function effectiveClaimOnRequest(
  kind: AgentKind,
  setting: boolean | null,
  credential: AgentCredential,
): boolean {
  if (kind !== "agent") return false;
  return setting ?? credential === "oauth";
}

/** trusted_creator only ever applies to requests with the agent's own token. */
export function effectiveTrustedCreator(
  kind: AgentKind,
  setting: boolean,
  credential: AgentCredential,
): boolean {
  return kind === "agent" && setting && credential === "token";
}

/** The release flag for task tools and UI. */
export function tasksEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.TASKS_ENABLED === "true" || env.TASKS_ENABLED === "1";
}
