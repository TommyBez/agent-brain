import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import { type Database, escapeLike } from "../brain/pages";
import { assertOwner } from "../brain/utils";
import { fingerprint } from "../canonical-json";
import { getPool, transaction } from "../db";
import type { Actor } from "./actors";
import { parseTaskInput, taskError } from "./errors";
import {
  everClaimedBy,
  latestClaim,
  latestOwnerAnswer,
  recordEvent,
} from "./events";
import {
  assertWorker,
  CLEARED_LEASE,
  releaseTarget,
  unblockDependents,
  updateTaskRow,
} from "./mutations";
import {
  type NextAction,
  ownerAction,
  POLL_AFTER_SECONDS,
  RETRY_AFTER_SECONDS,
} from "./next-actions";
import { listTaskLinks, resolveProject } from "./page-links";
import {
  onRequestPredicate,
  PROJECT_PAUSED,
  QUEUE_ORDER,
  queuePredicate,
  standardPredicate,
} from "./predicates";
import {
  authored,
  iso,
  type LockedTask,
  loadTaskRow,
  lockTask,
  type ProducedLink,
  refCondition,
  type StoredCompletion,
  taskView,
} from "./records";
import {
  claimTaskSchema,
  completeTaskSchema,
  releaseTaskSchema,
  reportTaskSchema,
} from "./schemas";
import { briefForTask } from "./service";
import {
  formatTaskRef,
  LEASE_MINUTES,
  REPORT_BY_FRACTION,
  TASK_LIMITS,
  type TaskStatus,
} from "./types";

const REQUIRED_REPORT = [
  "summary",
  "criteria",
  "pagesChanged",
  "artifacts",
  "remaining",
] as const;

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

type ClaimedFrom =
  | "ready"
  | "expired_lease"
  | "stale_question"
  | "own_triage"
  | "owner_request";

interface ClaimCandidate extends QueryResultRow {
  id: string;
  number: number;
  status: TaskStatus;
  approved_at: Date | null;
  created_by_agent_id: string;
  claimed_by_agent_id: string | null;
  lease_expired: boolean;
  question_stale: boolean;
  holder_label: string | null;
  holder_verified: boolean | null;
}

/** An agent name in server-written text; self-declared names are flagged. */
function agentName(label: string | null, verified: boolean | null) {
  return verified ? `${label}` : `${label} (unverified name)`;
}

/** A person or group lead, with the party's author (the owner or the task keeper). */
interface HumanLead {
  name: string;
  authorLabel: string;
  authorKind: string;
}

const CANDIDATE_COLUMNS = `t.id, t.number, t.status, t.approved_at, t.created_by_agent_id,
  t.claimed_by_agent_id, t.lease_expires_at, t.requires_human, t.archived_at, t.delegate_agent_id,
  (t.lease_id IS NOT NULL AND t.lease_expires_at < now()) AS lease_expired,
  (t.status = 'needs_input' AND t.input_requested_at < now() - interval '14 days') AS question_stale,
  (SELECT a.label FROM brain_agents a WHERE a.owner_id = t.owner_id AND a.id = t.claimed_by_agent_id) AS holder_label,
  (SELECT a.label_verified FROM brain_agents a WHERE a.owner_id = t.owner_id AND a.id = t.claimed_by_agent_id) AS holder_verified`;

async function takeLease(
  db: Database,
  actor: Actor,
  task: ClaimCandidate,
  minutes: number,
  claimedFrom: ClaimedFrom,
  extra: {
    quote?: string;
    leads?: string[];
    clientRunId?: string;
  },
) {
  const { rows } = await db.query(
    `UPDATE brain_tasks SET status = 'in_progress', claimed_by_agent_id = $3, lease_id = gen_random_uuid(),
       lease_expires_at = now() + make_interval(mins => $4), claimed_at = now(), input_requested_at = NULL,
       status_note = NULL, claim_count = claim_count + 1, updated_at = now()
     WHERE owner_id = $1 AND id = $2
     RETURNING lease_id, lease_expires_at, now() + make_interval(secs => $5) AS report_by`,
    [
      actor.ownerId,
      task.id,
      actor.agentId,
      minutes,
      Math.round(minutes * 60 * REPORT_BY_FRACTION),
    ],
  );
  // A claim never approves: remember where it started so a release returns there.
  const startStatus =
    task.status === "triage" || task.status === "ready"
      ? task.status
      : ((await latestClaim(db, actor.ownerId, task.id)).startStatus ??
        "ready");
  const leads = extra.leads ?? [];
  await recordEvent(db, {
    ownerId: actor.ownerId,
    taskId: task.id,
    actorAgentId: actor.agentId,
    action: "claimed",
    fromStatus: task.status,
    toStatus: "in_progress",
    note:
      claimedFrom === "owner_request"
        ? `On the owner's request${leads.length ? `, lead: ${leads.join(", ")}` : ""}`
        : null,
    payload: {
      claimedFrom,
      startStatus,
      leaseMinutes: minutes,
      ...(extra.quote ? { ownerRequest: { quote: extra.quote } } : {}),
      ...(leads.length ? { leads } : {}),
      ...(task.claimed_by_agent_id && task.holder_label
        ? { previousHolder: task.holder_label }
        : {}),
      ...(extra.clientRunId ? { clientRunId: extra.clientRunId } : {}),
    },
  });
  return {
    leaseId: rows[0].lease_id as string,
    leaseExpiresAt: iso(rows[0].lease_expires_at) as string,
    reportBy: iso(rows[0].report_by) as string,
  };
}

function notClaimable(
  ref: string,
  status: string,
  reason: string,
  message: string,
  remedy: string,
  details: Record<string, unknown> = {},
) {
  return taskError("NOT_CLAIMABLE", message, remedy, {
    ref,
    status,
    reason,
    ...details,
  });
}

async function claimByRef(
  actor: Actor,
  ref: string,
  minutes: number,
  quote: string | undefined,
  clientRunId: string | undefined,
) {
  const where = refCondition(ref, 4);
  return transaction(async (db) => {
    const { rows } = await db.query<
      ClaimCandidate & {
        standard_ok: boolean;
        request_ok: boolean;
        has_capability: boolean;
        project_paused: boolean;
        human_leads: HumanLead[];
        delegate_label: string | null;
        delegate_verified: boolean | null;
      }
    >(
      `SELECT ${CANDIDATE_COLUMNS},
         ${standardPredicate("$2", "$3")} AS standard_ok,
         ${onRequestPredicate("$2")} AS request_ok,
         (t.required_capability IS NULL OR t.required_capability = ANY($3::text[])) AS has_capability,
         ${PROJECT_PAUSED} AS project_paused,
         coalesce((SELECT json_agg(json_build_object('name', coalesce(pg.title, p.group_label),
                    'authorLabel', c.label, 'authorKind', c.kind) ORDER BY p.created_at, p.id)
               FROM brain_task_parties p
               LEFT JOIN brain_pages pg ON pg.owner_id = p.owner_id AND pg.id = p.person_page_id
               JOIN brain_agents c ON c.owner_id = p.owner_id AND c.id = p.created_by_agent_id
               WHERE p.owner_id = t.owner_id AND p.task_id = t.id AND p.role = 'lead'
                 AND p.kind IN ('person','group')), '[]'::json) AS human_leads,
         (SELECT a.label FROM brain_agents a WHERE a.owner_id = t.owner_id AND a.id = t.delegate_agent_id) AS delegate_label,
         (SELECT a.label_verified FROM brain_agents a WHERE a.owner_id = t.owner_id AND a.id = t.delegate_agent_id) AS delegate_verified
       FROM brain_tasks t WHERE t.owner_id = $1 AND ${where.sql} FOR UPDATE`,
      [actor.ownerId, actor.agentId, actor.agent.capabilities, ...where.params],
    );
    const task = rows[0];
    if (!task)
      throw taskError(
        "TASK_NOT_FOUND",
        `Task ${ref} was not found.`,
        "Use a reference such as T-42 from list_tasks.",
        { ref },
      );
    const taskRef = formatTaskRef(task.number);
    const ok = quote ? task.request_ok : task.standard_ok;
    if (!ok) {
      if (task.archived_at)
        throw notClaimable(
          taskRef,
          task.status,
          "archived",
          `${taskRef} is archived.`,
          "Choose another task.",
        );
      if (task.requires_human)
        throw notClaimable(
          taskRef,
          task.status,
          "requires_human",
          `${taskRef} needs a step only a person can take.`,
          "Do not claim it; tell the owner it requires a human step.",
        );
      if (task.delegate_agent_id && task.delegate_agent_id !== actor.agentId)
        throw notClaimable(
          taskRef,
          task.status,
          "assigned_to_other_agent",
          `${taskRef} is assigned to ${agentName(task.delegate_label, task.delegate_verified)}.`,
          "Only the assigned agent can claim it, even on request: name it to the owner, who can change the assignment in the app.",
          {
            agent: task.delegate_label,
            agentLabelVerified: task.delegate_verified === true,
          },
        );
      // An expired lease or a stale question is reclaimable: report its real reason.
      const leased =
        (task.status === "in_progress" || task.status === "needs_input") &&
        task.claimed_by_agent_id !== null &&
        !task.lease_expired &&
        !task.question_stale;
      if (leased)
        throw taskError(
          "LEASE_HELD",
          `${taskRef} is held by ${agentName(task.holder_label, task.holder_verified)}.`,
          "Choose another task; do not take over an active lease.",
          {
            ref: taskRef,
            status: task.status,
            holder: task.holder_label,
            holderLabelVerified: task.holder_verified === true,
            leaseExpiresAt: iso(task.lease_expires_at),
          },
        );
      if (
        !["ready", "triage"].includes(task.status) &&
        !task.lease_expired &&
        !task.question_stale
      )
        throw notClaimable(
          taskRef,
          task.status,
          "status",
          `${taskRef} is ${task.status} and cannot be claimed.`,
          task.status === "on_hold"
            ? "The owner put it on hold; only they resume it."
            : "Only ready or triage tasks can be claimed.",
        );
      if (!task.approved_at && task.created_by_agent_id !== actor.agentId)
        throw notClaimable(
          taskRef,
          task.status,
          "not_approved",
          `${taskRef} is not approved for other agents.`,
          "Ask the owner to approve it in the app; claim it with onOwnerRequest only if the owner explicitly asked you to take it in this conversation.",
        );
      if (!task.has_capability)
        throw notClaimable(
          taskRef,
          task.status,
          "missing_capability",
          `${taskRef} requires a capability you do not have.`,
          "Leave it to an agent with that capability.",
        );
      if (task.human_leads.length)
        throw notClaimable(
          taskRef,
          task.status,
          "human_lead",
          `${taskRef} is led by a person or group.`,
          "Do not take it from the queue; the owner may ask you explicitly to take it.",
          {
            leads: task.human_leads.map((lead) =>
              authored(lead.name, {
                label: lead.authorLabel,
                kind: lead.authorKind,
              }),
            ),
          },
        );
      if (task.project_paused)
        throw notClaimable(
          taskRef,
          task.status,
          "project_paused",
          `${taskRef}'s project is paused.`,
          "Do not take it from the queue; the owner may ask you explicitly to take it.",
        );
      throw notClaimable(
        taskRef,
        task.status,
        "not_claimable",
        `${taskRef} cannot be claimed now.`,
        "Read it with read_task and choose another task.",
      );
    }
    const claimedFrom: ClaimedFrom = quote
      ? "owner_request"
      : task.lease_expired
        ? "expired_lease"
        : task.question_stale
          ? "stale_question"
          : task.approved_at
            ? "ready"
            : "own_triage";
    const lease = await takeLease(db, actor, task, minutes, claimedFrom, {
      quote,
      leads: quote ? task.human_leads.map((lead) => lead.name) : undefined,
      clientRunId,
    });
    return { taskId: task.id, claimedFrom, ...lease };
  });
}

async function claimNext(
  actor: Actor,
  next: { projectRef?: string; query?: string },
  minutes: number,
  clientRunId: string | undefined,
) {
  return transaction(async (db) => {
    const params: unknown[] = [
      actor.ownerId,
      actor.agentId,
      actor.agent.capabilities,
    ];
    const filters: string[] = [];
    if (next.projectRef) {
      params.push(
        (await resolveProject(db, actor.ownerId, next.projectRef)).id,
      );
      filters.push(`AND t.project_page_id = $${params.length}`);
    }
    if (next.query) {
      params.push(next.query, `%${escapeLike(next.query)}%`);
      filters.push(
        `AND (t.search_document @@ websearch_to_tsquery('simple', $${params.length - 1}) OR t.title ILIKE $${params.length})`,
      );
    }
    const { rows } = await db.query<ClaimCandidate>(
      `SELECT ${CANDIDATE_COLUMNS} FROM brain_tasks t
       WHERE t.owner_id = $1 AND ${queuePredicate("$2", "$3")} ${filters.join(" ")}
       ORDER BY ${QUEUE_ORDER}
       FOR UPDATE OF t SKIP LOCKED LIMIT 1`,
      params,
    );
    const task = rows[0];
    if (!task)
      throw taskError(
        "NO_CLAIMABLE_TASK",
        "No task is claimable for you right now.",
        `Retry after ${RETRY_AFTER_SECONDS} seconds, or ask the owner what to work on.`,
        { retryAfterSeconds: RETRY_AFTER_SECONDS },
      );
    const claimedFrom: ClaimedFrom = task.lease_expired
      ? "expired_lease"
      : task.question_stale
        ? "stale_question"
        : task.approved_at
          ? "ready"
          : "own_triage";
    const lease = await takeLease(db, actor, task, minutes, claimedFrom, {
      clientRunId,
    });
    return { taskId: task.id, claimedFrom, ...lease };
  });
}

function holderActions(ref: string, reportBy: string): NextAction[] {
  return [
    {
      kind: "tool",
      tool: "report_task",
      args: { ref },
      reason: `Report before ${reportBy} with your leaseId; that is the only way to renew the lease.`,
    },
    {
      kind: "tool",
      tool: "complete_task",
      args: { ref },
      reason:
        "Write durable knowledge to pages first, then complete with pagesChanged.",
    },
  ];
}

/**
 * claim_task: by reference, the next task in the queue, or by reference on
 * the owner's explicit request. Only this response carries the lease id.
 */
export async function claimTask(actor: Actor, input: unknown) {
  assertOwner(actor.ownerId);
  assertWorker(actor);
  const data = parseTaskInput(claimTaskSchema, input);
  if (data.onOwnerRequest && !actor.claimOnRequest)
    throw taskError(
      "CLAIM_ON_REQUEST_DISABLED",
      "This agent cannot claim tasks on the owner's request.",
      "Ask the owner to approve the task in the app, or to enable 'Can claim on request' for this agent in /agents.",
    );
  const minutes = data.leaseMinutes ?? LEASE_MINUTES.default;
  const claimed = data.ref
    ? await claimByRef(
        actor,
        data.ref,
        minutes,
        data.onOwnerRequest?.quote,
        data.clientRunId,
      )
    : await claimNext(actor, data.next ?? {}, minutes, data.clientRunId);
  const db = getPool();
  const task = taskView(await loadTaskRow(db, actor.ownerId, claimed.taskId));
  const [brief, links] = await Promise.all([
    briefForTask(actor.ownerId, task),
    listTaskLinks(db, actor.ownerId, claimed.taskId),
  ]);
  return {
    task,
    leaseId: claimed.leaseId,
    leaseExpiresAt: claimed.leaseExpiresAt,
    reportBy: claimed.reportBy,
    claimedFrom: claimed.claimedFrom,
    brief,
    links,
    requiredReport: REQUIRED_REPORT,
    nextActions: holderActions(task.ref, claimed.reportBy),
  };
}

/**
 * Fencing: the caller must be the holder and present the current lease id.
 * An old holder gets LEASE_LOST; anyone else NOT_TASK_HOLDER.
 */
async function fence(
  db: Database,
  ownerId: string,
  task: LockedTask,
  actor: Actor,
  leaseId: string,
) {
  const presented = leaseId.toLowerCase();
  const holder = task.claimed_by_agent_id === actor.agentId;
  const matches = task.lease_id !== null && task.lease_id === presented;
  if (holder && matches) return;
  // A matching lease id from another agent is a leaked secret, never a takeover.
  if (!matches && (await everClaimedBy(db, ownerId, task.id, actor.agentId)))
    throw taskError(
      "LEASE_LOST",
      `Your lease on ${task.ref} is no longer valid.`,
      "Read the task again with read_task: another agent may have claimed it or the owner released it. Do not repeat work blindly.",
      { ref: task.ref, status: task.status },
    );
  throw taskError(
    "NOT_TASK_HOLDER",
    `You do not hold ${task.ref}.`,
    "Only the agent that claimed a task reports, releases or completes it; claim a task with claim_task first.",
    { ref: task.ref },
  );
}

async function leaseMinutesOf(
  db: Database,
  ownerId: string,
  taskId: string,
): Promise<number> {
  const { rows } = await db.query(
    `SELECT (payload->>'leaseMinutes')::int AS minutes FROM brain_task_events
     WHERE owner_id = $1 AND task_id = $2 AND action IN ('claimed','reported')
       AND jsonb_typeof(payload->'leaseMinutes') = 'number'
     ORDER BY id DESC LIMIT 1`,
    [ownerId, taskId],
  );
  return rows[0]?.minutes ?? LEASE_MINUTES.default;
}

/** report_task: the only renewal; a question suspends the lease in needs_input. */
export async function reportTask(actor: Actor, input: unknown) {
  assertOwner(actor.ownerId);
  assertWorker(actor);
  const ownerId = actor.ownerId;
  const data = parseTaskInput(reportTaskSchema, input);
  const result = await transaction(async (db) => {
    const task = await lockTask(db, ownerId, data.ref);
    await fence(db, ownerId, task, actor, data.leaseId);
    const minutes =
      data.leaseMinutes ?? (await leaseMinutesOf(db, ownerId, task.id));
    let status = task.status;
    if (data.question) {
      await updateTaskRow(
        db,
        ownerId,
        task.id,
        { status: "needs_input", status_note: data.question.prompt },
        ["lease_expires_at = NULL", "input_requested_at = now()"],
      );
      status = "needs_input";
    } else if (task.status === "in_progress") {
      await db.query(
        `UPDATE brain_tasks SET lease_expires_at = now() + make_interval(mins => $3), updated_at = now()
         WHERE owner_id = $1 AND id = $2`,
        [ownerId, task.id, minutes],
      );
    }
    await recordEvent(db, {
      ownerId,
      taskId: task.id,
      actorAgentId: actor.agentId,
      action: "reported",
      note: data.note,
      payload: status === "in_progress" ? { leaseMinutes: minutes } : {},
    });
    if (data.question)
      await recordEvent(db, {
        ownerId,
        taskId: task.id,
        actorAgentId: actor.agentId,
        action: "asked",
        fromStatus: task.status,
        toStatus: "needs_input",
        note: data.question.prompt,
        payload: {
          statusNote: true,
          ...(data.question.choices?.length
            ? { choices: data.question.choices }
            : {}),
        },
      });
    const { rows } = await db.query(
      `SELECT lease_expires_at, CASE WHEN lease_expires_at IS NULL THEN NULL
         ELSE now() + make_interval(secs => $3) END AS report_by
       FROM brain_tasks WHERE owner_id = $1 AND id = $2`,
      [ownerId, task.id, Math.round(minutes * 60 * REPORT_BY_FRACTION)],
    );
    return {
      task,
      status,
      leaseExpiresAt: iso(rows[0].lease_expires_at),
      reportBy: iso(rows[0].report_by),
      ownerAnswer: data.question
        ? null
        : await latestOwnerAnswer(db, ownerId, task.id),
    };
  });
  const nextActions: NextAction[] =
    result.status === "needs_input"
      ? [
          ownerAction(
            result.task.ref,
            "answer",
            `Show the owner this link to answer your question on ${result.task.ref}.`,
          ),
          {
            kind: "tool",
            tool: "read_task",
            args: { ref: result.task.ref },
            reason: `Poll every ${POLL_AFTER_SECONDS} seconds or later for the answer; you keep the claim meanwhile.`,
          },
        ]
      : holderActions(result.task.ref, result.reportBy ?? "");
  return {
    ref: result.task.ref,
    status: result.status,
    leaseExpiresAt: result.leaseExpiresAt,
    reportBy: result.reportBy,
    ownerAnswer: result.ownerAnswer,
    ...(result.status === "needs_input"
      ? { pollAfterSeconds: POLL_AFTER_SECONDS }
      : {}),
    nextActions,
  };
}

/** release_task: hand off, give up or report a block; the lease ends here. */
export async function releaseTask(actor: Actor, input: unknown) {
  assertOwner(actor.ownerId);
  assertWorker(actor);
  const ownerId = actor.ownerId;
  const data = parseTaskInput(releaseTaskSchema, input);
  return transaction(async (db) => {
    const task = await lockTask(db, ownerId, data.ref);
    await fence(db, ownerId, task, actor, data.leaseId);
    const target: TaskStatus =
      data.reason === "blocked"
        ? "blocked"
        : await releaseTarget(db, ownerId, task);
    await updateTaskRow(db, ownerId, task.id, {
      status: target,
      blocked_reason: data.blockedReason ?? null,
      status_note: data.note.slice(0, TASK_LIMITS.statusNote),
      ...CLEARED_LEASE,
    });
    await recordEvent(db, {
      ownerId,
      taskId: task.id,
      actorAgentId: actor.agentId,
      action: "released",
      fromStatus: task.status,
      toStatus: target,
      note: data.note,
      payload: {
        reason: data.reason,
        statusNote: true,
        ...(data.blockedReason ? { blockedReason: data.blockedReason } : {}),
      },
    });
    const nextActions: NextAction[] =
      target === "blocked"
        ? [
            ownerAction(
              task.ref,
              "unblock",
              `Show the owner this link: ${task.ref} is blocked (${data.blockedReason}).`,
            ),
          ]
        : [];
    return { ref: task.ref, status: target, nextActions };
  });
}

interface PageCheck {
  ref: string;
  version: number;
}

async function verifyPages(
  db: Database,
  ownerId: string,
  task: LockedTask,
  holderId: string,
  pages: PageCheck[],
) {
  const produced: ProducedLink[] = [];
  const ignored: { ref: string; reason: string }[] = [];
  // Pages the holder wrote under this claim; earlier claims' links do not count.
  let verifiedCount = 0;
  const seen = new Set<string>();
  for (const entry of pages) {
    const key = `${entry.ref}@${entry.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { rows } = await db.query(
      `SELECT p.id, p.slug, r.actor_agent_id, r.created_at >= $4 AS after_claim
       FROM brain_pages p
       LEFT JOIN brain_revisions r ON r.owner_id = p.owner_id AND r.page_id = p.id AND r.version = $3
       WHERE p.owner_id = $1 AND (p.id::text = $2 OR p.slug = $2)`,
      [ownerId, entry.ref, entry.version, task.claimed_at],
    );
    const page = rows[0];
    if (!page) {
      ignored.push({ ref: entry.ref, reason: "page_not_found" });
      continue;
    }
    if (page.after_claim === null) {
      ignored.push({ ref: entry.ref, reason: "no_revision" });
      continue;
    }
    const verified = page.actor_agent_id === holderId && page.after_claim;
    const [link] = await db
      .query(
        `INSERT INTO brain_task_links AS l (owner_id, task_id, page_id, role, origin, status, evidence, created_by_agent_id)
       VALUES ($1, $2, $3, 'produced', 'provenance', $4, $5::jsonb, $6)
       ON CONFLICT (owner_id, task_id, page_id, role) DO UPDATE SET
         status = CASE WHEN l.status = 'rejected' THEN 'rejected'
                       WHEN excluded.status = 'active' THEN 'active' ELSE l.status END,
         evidence = CASE WHEN l.status = 'rejected' THEN l.evidence ELSE excluded.evidence END,
         updated_at = now()
       RETURNING status`,
        [
          ownerId,
          task.id,
          page.id,
          verified ? "active" : "suggested",
          JSON.stringify({ basis: "revision", pageVersion: entry.version }),
          holderId,
        ],
      )
      .then((result) => result.rows);
    if (link.status === "rejected") {
      ignored.push({ ref: entry.ref, reason: "rejected_by_owner" });
      continue;
    }
    if (verified) verifiedCount++;
    produced.push({
      pageId: page.id,
      slug: page.slug,
      version: entry.version,
      status: link.status,
    });
  }
  return { produced, ignored, verifiedCount };
}

/**
 * complete_task: verifies the report and the produced pages, then closes the
 * task (review_policy auto) or sends it to the owner (in_review). Replays of
 * the same completion return replayed:true.
 */
export async function completeTask(actor: Actor, input: unknown) {
  assertOwner(actor.ownerId);
  assertWorker(actor);
  const ownerId = actor.ownerId;
  const data = parseTaskInput(completeTaskSchema, input);
  const leaseHash = sha256(data.leaseId.toLowerCase());
  const reportFingerprint = fingerprint({
    summary: data.summary,
    criteria: data.criteria,
    pagesChanged: data.pagesChanged,
    artifacts: data.artifacts,
    remaining: data.remaining ?? null,
  });
  return transaction(async (db) => {
    const task = await lockTask(db, ownerId, data.ref);
    if (task.lease_id === null && task.completed_lease_hash === leaseHash) {
      if (task.completion?.fingerprint !== reportFingerprint)
        throw taskError(
          "ALREADY_COMPLETED",
          `${task.ref} was already completed with a different report under this lease.`,
          "Read the task with read_task; do not complete it again.",
          { ref: task.ref, status: task.status },
        );
      return {
        ref: task.ref,
        status: task.status,
        producedLinks: task.completion.producedLinks,
        ignoredPages: task.completion.ignoredPages,
        replayed: true,
        nextActions: [] as NextAction[],
      };
    }
    await fence(db, ownerId, task, actor, data.leaseId);
    // needs_input keeps the lease, but the owner's open question must be
    // answered (or the task released) before the holder can complete it.
    if (task.status !== "in_progress")
      throw taskError(
        "INVALID_TRANSITION",
        `${task.ref} is waiting for the owner's answer.`,
        `Poll read_task every ${POLL_AFTER_SECONDS} seconds or later for ownerAnswer and complete after the task resumes, or call release_task.`,
        { ref: task.ref, status: task.status },
      );
    const criteriaCount = task.acceptance_criteria.length;
    const outOfRange = data.criteria.filter(
      (criterion) => criterion.index >= criteriaCount,
    );
    if (outOfRange.length)
      throw taskError(
        "INVALID_INPUT",
        `${task.ref} has ${criteriaCount} acceptance criteria.`,
        "Report criteria by their zero-based index in the task's acceptanceCriteria.",
        { indexes: outOfRange.map((criterion) => criterion.index) },
      );
    const missing: string[] = [];
    for (let index = 0; index < criteriaCount; index++)
      if (!data.criteria.some((criterion) => criterion.index === index))
        missing.push(`criteria[${index}]`);
    if (
      data.criteria.some((criterion) => criterion.status !== "met") &&
      !data.remaining
    )
      missing.push("remaining");
    if (missing.length)
      throw taskError(
        "REPORT_INCOMPLETE",
        `The completion report for ${task.ref} is incomplete.`,
        "Report every acceptance criterion with evidence, and describe what remains when a criterion is not fully met.",
        { ref: task.ref, missing },
      );
    const { produced, ignored, verifiedCount } = await verifyPages(
      db,
      ownerId,
      task,
      actor.agentId,
      data.pagesChanged,
    );
    if (
      (task.expected_output === "page" ||
        task.expected_output === "decision") &&
      !verifiedCount
    )
      throw taskError(
        "OUTPUT_REQUIRED",
        `${task.ref} expects a ${task.expected_output} page that you wrote while holding it.`,
        "Write the outcome with write or append, then list the page and the version they returned in pagesChanged.",
        {
          ref: task.ref,
          expectedOutput: task.expected_output,
          ignoredPages: ignored,
        },
      );
    if (task.expected_output === "artifact" && !data.artifacts.length)
      throw taskError(
        "OUTPUT_REQUIRED",
        `${task.ref} expects an artifact.`,
        "List the pull request, branch, commit, URL or file in artifacts.",
        { ref: task.ref, expectedOutput: task.expected_output },
      );
    const status: TaskStatus =
      task.review_policy === "owner" ? "in_review" : "done";
    const completion: StoredCompletion = {
      summary: data.summary,
      criteria: data.criteria,
      artifacts: data.artifacts,
      ...(data.remaining ? { remaining: data.remaining } : {}),
      fingerprint: reportFingerprint,
      pagesChanged: data.pagesChanged,
      producedLinks: produced,
      ignoredPages: ignored,
      completedByAgentId: actor.agentId,
      completedByLabel: actor.agent.label,
      completedByKind: actor.agent.kind,
    };
    await updateTaskRow(
      db,
      ownerId,
      task.id,
      {
        status,
        completion,
        completed_lease_hash: leaseHash,
        blocked_reason: null,
        status_note: null,
        ...CLEARED_LEASE,
      },
      [status === "done" ? "completed_at = now()" : "completed_at = NULL"],
    );
    await recordEvent(db, {
      ownerId,
      taskId: task.id,
      actorAgentId: actor.agentId,
      action: "completed",
      fromStatus: task.status,
      toStatus: status,
      note: data.summary,
      payload: {
        producedLinks: produced.length,
        ignoredPages: ignored.length,
        artifacts: data.artifacts.length,
      },
    });
    if (produced.length)
      await recordEvent(db, {
        ownerId,
        taskId: task.id,
        actorAgentId: actor.agentId,
        action: "links_changed",
        payload: {
          produced: produced.map((link) => ({
            pageId: link.pageId,
            version: link.version,
            status: link.status,
          })),
        },
      });
    if (status === "done")
      await unblockDependents(db, ownerId, task, actor.agentId);
    return {
      ref: task.ref,
      status,
      producedLinks: produced,
      ignoredPages: ignored,
      replayed: false,
      nextActions:
        status === "in_review"
          ? [
              ownerAction(
                task.ref,
                "review",
                `Show the owner this link to review ${task.ref}.`,
              ),
            ]
          : ([] as NextAction[]),
    };
  });
}
