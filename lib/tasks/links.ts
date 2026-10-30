import type { PoolClient } from "pg";
import type { Database } from "../brain/pages";
import { recordEvent } from "./events";
import { existingPageIds, mentionedPageRefs } from "./page-links";
import type { TaskLinkRole, TaskLinkStatus } from "./types";

// Conciliator link primitives shared by the synchronous rules, retrieval
// suggestions and the nightly Jev pass (§8.1, §8.3). The conciliator writes
// only `rule` and `consolidator` rows and never touches owner, agent,
// provenance or task keeper rows, nor any rejected row (§6.4).

export const TASK_RULES_VERSION = "task-rules-v1";

export type MachineOrigin = "rule" | "consolidator";

export interface ExistingTaskLink {
  pageId: string;
  role: TaskLinkRole;
  origin: string;
  status: TaskLinkStatus;
  confidence: number | null;
  evidence: Record<string, unknown> & { basis?: string };
  decidedAt: string | null;
}

export interface MachineLinkWrite {
  pageId: string;
  role: TaskLinkRole;
  origin: MachineOrigin;
  status: Exclude<TaskLinkStatus, "rejected">;
  confidence: number | null;
  evidence: Record<string, unknown>;
}

export interface LinkChange {
  pageId: string;
  role: TaskLinkRole;
  status: TaskLinkStatus;
  /** NULL for a new row. */
  previous: TaskLinkStatus | null;
}

/** The content the conciliator links from; never the lease or claim state. */
export interface LockedLinkTask {
  id: string;
  number: number;
  status: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  projectPageId: string | null;
  archivedAt: string | null;
  semanticFingerprint: string | null;
  embeddingModel: string | null;
}

/**
 * Reads a task for linking. With `lock`, serializes conciliator writes per
 * task and holds the row against concurrent content edits until commit; take
 * it before any link write so lock order matches the task service.
 */
export async function lockTaskForLinks(
  db: Database,
  ownerId: string,
  taskId: string,
  lock = true,
): Promise<LockedLinkTask | null> {
  if (lock)
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext('task-links:' || $2))",
      [ownerId, taskId],
    );
  const { rows } = await db.query(
    `SELECT id, number, status, title, description, acceptance_criteria, project_page_id,
       archived_at, semantic_fingerprint, embedding_model
     FROM brain_tasks WHERE owner_id = $1 AND id = $2 ${lock ? "FOR SHARE" : ""}`,
    [ownerId, taskId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptance_criteria,
    projectPageId: row.project_page_id,
    archivedAt: row.archived_at
      ? new Date(row.archived_at).toISOString()
      : null,
    semanticFingerprint: row.semantic_fingerprint,
    embeddingModel: row.embedding_model,
  };
}

export async function existingTaskLinks(
  db: Database,
  ownerId: string,
  taskId: string,
): Promise<ExistingTaskLink[]> {
  const { rows } = await db.query(
    `SELECT page_id, role, origin, status, confidence, evidence, decided_at
     FROM brain_task_links WHERE owner_id = $1 AND task_id = $2
     ORDER BY page_id, role`,
    [ownerId, taskId],
  );
  return rows.map((row) => ({
    pageId: row.page_id,
    role: row.role,
    origin: row.origin,
    status: row.status,
    confidence: row.confidence,
    evidence: row.evidence ?? {},
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
  }));
}

/**
 * Writes conciliator links. The WHERE clause is the §6.4 guard: an existing
 * row is rewritten only when it is a rule or consolidator row that is not
 * rejected, and only when something actually changes.
 */
export async function writeMachineLinks(
  db: Database,
  ownerId: string,
  taskId: string,
  agentId: string,
  writes: MachineLinkWrite[],
): Promise<LinkChange[]> {
  if (!writes.length) return [];
  const { rows } = await db.query(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($4::jsonb)
         AS x(page_id uuid, role text, origin text, status text, confidence real, evidence jsonb)
     ), previous AS (
       SELECT l.page_id, l.role, l.status FROM brain_task_links l JOIN input i USING (page_id, role)
       WHERE l.owner_id = $1 AND l.task_id = $2
     ), written AS (
       INSERT INTO brain_task_links AS l (owner_id, task_id, page_id, role, origin, status, confidence, evidence, created_by_agent_id)
       SELECT $1, $2, page_id, role, origin, status, confidence, evidence, $3 FROM input
       ON CONFLICT (owner_id, task_id, page_id, role) DO UPDATE SET
         origin = excluded.origin, status = excluded.status, confidence = excluded.confidence,
         evidence = excluded.evidence, updated_at = now()
       WHERE l.origin IN ('rule', 'consolidator') AND l.status <> 'rejected'
         AND (l.origin, l.status, l.confidence, l.evidence)
           IS DISTINCT FROM (excluded.origin, excluded.status, excluded.confidence, excluded.evidence)
       RETURNING l.page_id, l.role, l.status
     )
     SELECT w.page_id, w.role, w.status, p.status AS previous
     FROM written w LEFT JOIN previous p USING (page_id, role)
     ORDER BY w.page_id, w.role`,
    [
      ownerId,
      taskId,
      agentId,
      JSON.stringify(
        writes.map((write) => ({
          page_id: write.pageId,
          role: write.role,
          origin: write.origin,
          status: write.status,
          confidence: write.confidence,
          evidence: write.evidence,
        })),
      ),
    ],
  );
  return rows.map((row) => ({
    pageId: row.page_id,
    role: row.role,
    status: row.status,
    previous: row.previous ?? null,
  }));
}

export function summarizeChanges(changes: LinkChange[]) {
  const pick = (test: (change: LinkChange) => boolean) =>
    changes
      .filter(test)
      .map((change) => ({ pageId: change.pageId, role: change.role }));
  return {
    suggested: pick(
      (change) =>
        change.status === "suggested" && change.previous !== "suggested",
    ),
    activated: pick(
      (change) => change.status === "active" && change.previous !== "active",
    ),
    retracted: pick((change) => change.status === "retracted"),
    updated: pick((change) => change.status === change.previous),
  };
}

/** One `links_changed` event by the conciliator, only when links changed. */
export async function recordLinkChanges(
  db: Database,
  ownerId: string,
  taskId: string,
  agentId: string,
  changes: LinkChange[],
  payload: Record<string, unknown>,
) {
  if (!changes.length) return;
  const summary = summarizeChanges(changes);
  await recordEvent(db, {
    ownerId,
    taskId,
    actorAgentId: agentId,
    action: "links_changed",
    payload: {
      ...payload,
      ...Object.fromEntries(
        Object.entries(summary).filter(([, items]) => items.length),
      ),
    },
  });
}

/** Deterministic rule links the task should have now. */
export async function desiredRuleLinks(
  db: Database,
  ownerId: string,
  task: Pick<LockedLinkTask, "description" | "projectPageId">,
): Promise<MachineLinkWrite[]> {
  const writes: MachineLinkWrite[] = [];
  if (task.projectPageId) {
    // Decisions decided_in the project are suggestions: a project can hold
    // many decisions and not all of them govern this task.
    const { rows } = await db.query(
      `SELECT DISTINCT d.id, d.version FROM brain_links l
       JOIN brain_pages d ON d.owner_id = l.owner_id AND d.id = l.source_id
       WHERE l.owner_id = $1 AND l.target_id = $2 AND l.type = 'decided_in' AND d.type = 'decision'
       ORDER BY d.id`,
      [ownerId, task.projectPageId],
    );
    for (const row of rows)
      writes.push({
        pageId: row.id,
        role: "decision",
        origin: "rule",
        status: "suggested",
        confidence: null,
        evidence: {
          basis: "decided_in",
          policyVersion: TASK_RULES_VERSION,
          pageVersion: row.version,
          projectId: task.projectPageId,
        },
      });
  }
  const mentioned = await existingPageIds(
    db,
    ownerId,
    mentionedPageRefs(task.description),
  );
  for (const page of mentioned)
    if (page.id !== task.projectPageId)
      writes.push({
        pageId: page.id,
        role: "context",
        origin: "rule",
        status: "active",
        confidence: null,
        evidence: {
          basis: "reference",
          policyVersion: TASK_RULES_VERSION,
          pageVersion: page.version,
          mention: true,
        },
      });
  return writes;
}

const isRuleRow = (link: ExistingTaskLink) =>
  link.origin === "rule" &&
  (link.evidence.basis === "decided_in" || link.evidence.basis === "reference");

/**
 * Pure rule reconciliation: add missing rule links (re-proposing retracted
 * machine rows, and activating machine suggestions of a mentioned page), keep
 * live ones untouched, and retract undecided rule links whose rule no longer
 * holds (mention removed, decision no longer decided_in the task's project).
 */
export function planRuleLinks(
  desired: MachineLinkWrite[],
  existing: ExistingTaskLink[],
): MachineLinkWrite[] {
  const writes: MachineLinkWrite[] = [];
  const key = (link: { pageId: string; role: string }) =>
    `${link.pageId}:${link.role}`;
  const wanted = new Set(desired.map(key));
  for (const write of desired) {
    const current = existing.find((link) => key(link) === key(write));
    if (!current) {
      // A mentioned page already linked in another role keeps one active row.
      const linked = existing.some(
        (link) => link.pageId === write.pageId && link.status === "active",
      );
      if (!(write.evidence.basis === "reference" && linked)) writes.push(write);
      continue;
    }
    const machine =
      current.origin === "rule" || current.origin === "consolidator";
    if (!machine || current.status === "rejected") continue;
    // An explicit mention promotes an undecided machine suggestion.
    const promote =
      write.status === "active" &&
      current.status === "suggested" &&
      current.decidedAt === null;
    if (current.status === "retracted" || promote) writes.push(write);
  }
  for (const link of existing)
    if (
      isRuleRow(link) &&
      !wanted.has(key(link)) &&
      link.decidedAt === null &&
      (link.status === "suggested" || link.status === "active")
    )
      writes.push({
        pageId: link.pageId,
        role: link.role,
        origin: "rule",
        status: "retracted",
        confidence: link.confidence,
        evidence: {
          ...link.evidence,
          retractedBecause: "rule_no_longer_holds",
        },
      });
  return writes;
}

/** Recomputes a task's rule links; the caller holds lockTaskForLinks. */
export async function refreshTaskRules(
  db: PoolClient,
  ownerId: string,
  task: LockedLinkTask,
  agentId: string,
): Promise<LinkChange[]> {
  const terminal =
    task.archivedAt !== null ||
    task.status === "done" ||
    task.status === "canceled";
  if (terminal) return [];
  const existing = await existingTaskLinks(db, ownerId, task.id);
  const changes = await writeMachineLinks(
    db,
    ownerId,
    task.id,
    agentId,
    planRuleLinks(await desiredRuleLinks(db, ownerId, task), existing),
  );
  await recordLinkChanges(db, ownerId, task.id, agentId, changes, {
    basis: "rule",
    policyVersion: TASK_RULES_VERSION,
  });
  return changes;
}
