import type { QueryResultRow } from "pg";
import type { Database } from "../brain/pages";
import { escapeLike } from "../brain/pages";
import { assertOwner } from "../brain/utils";
import { fingerprint } from "../canonical-json";
import { getPool, transaction } from "../db";
import type { Actor } from "./actors";
import { buildTaskBrief, type TaskBrief } from "./brief";
import { syncDerivedTaskLinks } from "./derived-links";
import { parseTaskInput, taskError, taskNotFound } from "./errors";
import {
  briefEvents,
  eventWatermark,
  formatEventCursor,
  latestOwnerAnswer,
  parseEventCursor,
  recentEvents,
  recordEvent,
} from "./events";
import {
  assertVersion,
  CLEARED_LEASE,
  isOwnerActor,
  updateTaskRow,
} from "./mutations";
import {
  type NextAction,
  ownerAction,
  POLL_AFTER_SECONDS,
} from "./next-actions";
import {
  existingPageIds,
  type LinkWrite,
  listTaskLinks,
  mentionedPageRefs,
  removeContextLinks,
  resolvePages,
  resolveProject,
  upsertTaskLinks,
} from "./page-links";
import { listTaskParties, partiesForAgents } from "./parties";
import {
  HUMAN_LEAD,
  OPEN_BLOCKERS,
  PROJECT_PAUSED,
  QUEUE_ORDER,
  queuePredicate,
} from "./predicates";
import {
  authored,
  type LockedTask,
  loadTaskRow,
  lockTask,
  refCondition,
  TASK_VIEW_SELECT,
  type TaskListRow,
  type TaskView,
  taskListRow,
  taskView,
} from "./records";
import {
  createTaskSchema,
  keeperCreateTaskSchema,
  listTasksSchema,
  ownerCreateTaskSchema,
  ownerUpdateTaskSchema,
  readTaskSchema,
  type TaskDueInput,
  updateTaskSchema,
} from "./schemas";
import {
  DEFAULT_TASK_PRIORITY,
  defaultReviewPolicy,
  formatTaskRef,
  OPEN_TASK_STATUSES,
  OWNER_REVIEWED_OUTPUTS,
  type TaskExpectedOutput,
  type TaskLinkOrigin,
} from "./types";

/** Per-agent creation limits (the task keeper has its own per-run cap). */
export const AGENT_CREATION_LIMITS = { perDay: 50, openTriage: 20 } as const;
const DUPLICATE_SIMILARITY = 0.55;

type CreateInput =
  | ReturnType<typeof createTaskSchema.parse>
  | ReturnType<typeof ownerCreateTaskSchema.parse>
  | ReturnType<typeof keeperCreateTaskSchema.parse>;

function dueColumns(due: TaskDueInput | undefined) {
  if (!due)
    return { due_kind: "unset", due_on: null, due_at: null, due_text: null };
  return {
    due_kind: due.kind,
    due_on: due.on ?? null,
    due_at: due.at ?? null,
    due_text: due.text ?? null,
  };
}

function linkOrigin(actor: Actor): TaskLinkOrigin {
  if (actor.agent.kind === "owner") return "owner";
  if (actor.agent.systemKey === "task_keeper") return "task_keeper";
  return "agent";
}

async function rateLimit(db: Database, actor: Actor, triage: boolean) {
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS today,
       count(*) FILTER (WHERE status = 'triage' AND archived_at IS NULL)::int AS triage,
       ceil(extract(epoch FROM min(created_at) FILTER (WHERE created_at > now() - interval '1 day') + interval '1 day' - now()))::int AS retry
     FROM brain_tasks WHERE owner_id = $1 AND created_by_agent_id = $2`,
    [actor.ownerId, actor.agentId],
  );
  const usage = rows[0];
  if (usage.today >= AGENT_CREATION_LIMITS.perDay)
    throw taskError(
      "RATE_LIMITED",
      `This agent created ${AGENT_CREATION_LIMITS.perDay} tasks in the last 24 hours.`,
      "Do not create more tasks now; report the remaining work to the owner in the conversation.",
      { limit: AGENT_CREATION_LIMITS.perDay, retryAfterSeconds: usage.retry },
    );
  if (triage && usage.triage >= AGENT_CREATION_LIMITS.openTriage)
    throw taskError(
      "RATE_LIMITED",
      `This agent already has ${AGENT_CREATION_LIMITS.openTriage} tasks waiting in triage.`,
      "Ask the owner to review your triage tasks in the app before creating more.",
      { limit: AGENT_CREATION_LIMITS.openTriage },
    );
}

async function parentFor(
  db: Database,
  actor: Actor,
  ref: string,
  mustHold: boolean,
): Promise<string> {
  const where = refCondition(ref, 2);
  const { rows } = await db.query(
    `SELECT t.id, t.claimed_by_agent_id, t.status, coalesce(t.lease_expires_at > now(), false) AS lease_live
     FROM brain_tasks t WHERE t.owner_id = $1 AND ${where.sql}`,
    [actor.ownerId, ...where.params],
  );
  const parent = rows[0];
  if (!parent) throw taskNotFound(ref);
  if (
    mustHold &&
    !(
      parent.claimed_by_agent_id === actor.agentId &&
      (parent.status === "needs_input" || parent.lease_live)
    )
  )
    throw taskError(
      "NOT_TASK_HOLDER",
      `You do not hold ${ref}, so you cannot create its subtask or handoff.`,
      "Claim the parent task first, or create the task with origin owner_request if the owner asked for it.",
      { ref },
    );
  return parent.id;
}

async function agentExists(db: Database, ownerId: string, agentId: string) {
  const { rowCount } = await db.query(
    "SELECT 1 FROM brain_agents WHERE owner_id = $1 AND id = $2 AND kind = 'agent' AND disabled_at IS NULL",
    [ownerId, agentId],
  );
  if (!rowCount)
    throw taskError(
      "AGENT_NOT_FOUND",
      "That agent is not an active connected agent.",
      "Choose an agent from the /agents registry.",
    );
}

function contextLinks(
  pages: { id: string; version: number }[],
  origin: TaskLinkOrigin,
  mention = false,
): LinkWrite[] {
  return pages.map((page) => ({
    pageId: page.id,
    role: "context",
    origin,
    status: "active",
    evidence: {
      basis: "reference",
      pageVersion: page.version,
      ...(mention ? { mention: true } : {}),
    },
  }));
}

async function runDerivedLinks(
  ownerId: string,
  taskId: string,
  actorAgentId: string,
  trigger: "created" | "updated",
) {
  try {
    await syncDerivedTaskLinks({ ownerId, taskId, actorAgentId, trigger });
  } catch (error) {
    console.error(
      "Derived task links failed",
      error instanceof Error ? error.name : "unknown error",
    );
  }
}

async function possibleDuplicates(
  ownerId: string,
  task: { id: string; title: string; projectId: string | null },
) {
  const { rows } = await getPool().query(
    `SELECT t.number, t.title, t.status, round(similarity(t.title, $3)::numeric, 2)::float AS similarity,
       creator.label AS creator_label, creator.kind AS creator_kind
     FROM brain_tasks t
     JOIN brain_agents creator ON creator.owner_id = t.owner_id AND creator.id = t.created_by_agent_id
     WHERE t.owner_id = $1 AND t.id <> $2 AND t.archived_at IS NULL
       AND t.status <> ALL(ARRAY['done','canceled'])
       AND t.project_page_id IS NOT DISTINCT FROM $4::uuid
       AND similarity(t.title, $3) >= $5
     ORDER BY similarity(t.title, $3) DESC, t.number LIMIT 5`,
    [ownerId, task.id, task.title, task.projectId, DUPLICATE_SIMILARITY],
  );
  return rows.map((row) => ({
    ref: formatTaskRef(row.number),
    title: authored(row.title as string, {
      label: row.creator_label,
      kind: row.creator_kind,
    }),
    status: row.status as string,
    similarity: row.similarity as number,
  }));
}

function creationNextActions(
  task: TaskView,
  actor: Actor,
  duplicates: { ref: string }[],
): NextAction[] {
  const actions: NextAction[] = [];
  if (!task.approved && actor.agent.kind === "agent")
    actions.push(
      {
        kind: "tool",
        tool: "claim_task",
        args: { ref: task.ref },
        reason: "You created it, so you may work it before approval.",
      },
      ownerAction(
        task.ref,
        "approve",
        `Only the owner can approve ${task.ref} for other agents; share this link if they want that.`,
      ),
    );
  else if (task.status === "ready" && actor.agent.kind === "agent")
    actions.push({
      kind: "tool",
      tool: "claim_task",
      args: { ref: task.ref },
      reason: "Claim it before working on it.",
    });
  for (const duplicate of duplicates.slice(0, 3))
    actions.push({
      kind: "tool",
      tool: "read_task",
      args: { ref: duplicate.ref },
      reason: "Possible duplicate: check it before continuing.",
    });
  return actions;
}

/**
 * Creates a task. Agents create only in the allowed cases (origin), land in
 * triage unless their policy says otherwise, and never approve for others.
 */
export async function createTask(actor: Actor, input: unknown) {
  assertOwner(actor.ownerId);
  const ownerId = actor.ownerId;
  const kind = actor.agent.kind;
  if (kind === "system" && actor.agent.systemKey !== "task_keeper")
    throw taskError(
      "NOT_ALLOWED",
      "The consolidator links knowledge to tasks; it never creates them.",
      "Leave task creation to the owner, allowed agent requests and the task keeper.",
    );
  const data: CreateInput =
    kind === "owner"
      ? parseTaskInput(ownerCreateTaskSchema, input)
      : kind === "agent"
        ? parseTaskInput(createTaskSchema, input)
        : parseTaskInput(keeperCreateTaskSchema, input);
  const expectedOutput: TaskExpectedOutput = data.expectedOutput ?? "none";
  const ownerFields =
    kind === "owner"
      ? (data as ReturnType<typeof ownerCreateTaskSchema.parse>)
      : undefined;
  const keeperFields =
    kind === "system"
      ? (data as ReturnType<typeof keeperCreateTaskSchema.parse>)
      : undefined;
  const reviewPolicy =
    ownerFields?.reviewPolicy ?? defaultReviewPolicy(expectedOutput);
  if (
    (OWNER_REVIEWED_OUTPUTS as readonly string[]).includes(expectedOutput) &&
    reviewPolicy !== "owner"
  )
    throw taskError(
      "INVALID_INPUT",
      "Decisions and external actions are always reviewed by the owner.",
      "Use reviewPolicy owner, or another expected output.",
    );
  const idempotencyKey =
    "idempotencyKey" in data ? (data.idempotencyKey ?? null) : null;
  const idempotencyFingerprint = idempotencyKey
    ? fingerprint({ ...data, idempotencyKey: undefined })
    : null;

  const outcome = await transaction(async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext('task-number'))",
      [ownerId],
    );
    if (idempotencyKey) {
      const existing = await db.query(
        `SELECT id, idempotency_fingerprint FROM brain_tasks
         WHERE owner_id = $1 AND created_by_agent_id = $2 AND idempotency_key = $3`,
        [ownerId, actor.agentId, idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].idempotency_fingerprint !== idempotencyFingerprint)
          throw taskError(
            "IDEMPOTENCY_KEY_CONFLICT",
            "This idempotencyKey was already used for a different task.",
            "Use a new idempotencyKey for a new task; reuse a key only to retry the identical request.",
            { idempotencyKey },
          );
        return { taskId: existing.rows[0].id as string, replayed: true };
      }
    }
    if (keeperFields?.extractionFingerprint) {
      const rejected = await db.query(
        "SELECT 1 FROM brain_task_extraction_rejections WHERE owner_id = $1 AND fingerprint = $2",
        [ownerId, keeperFields.extractionFingerprint],
      );
      if (rejected.rowCount)
        throw taskError(
          "EXTRACTION_REJECTED",
          "The owner rejected this extraction before.",
          "Skip it; rejected extractions never return.",
        );
      const existing = await db.query(
        "SELECT id FROM brain_tasks WHERE owner_id = $1 AND extraction_fingerprint = $2",
        [ownerId, keeperFields.extractionFingerprint],
      );
      if (existing.rows[0])
        return { taskId: existing.rows[0].id as string, replayed: true };
    }
    let recurrenceApprover: string | null = null;
    if (keeperFields?.origin === "recurrence") {
      const series = await db.query(
        `SELECT r.created_by_agent_id,
           (SELECT id FROM brain_tasks WHERE owner_id = $1 AND recurrence_id = r.id AND occurrence_on = $3::date) AS existing
         FROM brain_task_recurrences r WHERE r.owner_id = $1 AND r.id = $2`,
        [ownerId, keeperFields.recurrenceId, keeperFields.occurrenceOn],
      );
      if (!series.rows[0])
        throw taskError(
          "INVALID_INPUT",
          "The recurrence does not exist.",
          "Create instances only for existing owner recurrences.",
        );
      if (series.rows[0].existing)
        return { taskId: series.rows[0].existing as string, replayed: true };
      recurrenceApprover = series.rows[0].created_by_agent_id;
    }

    let status: "triage" | "ready" = "triage";
    let approvedBy: string | null = null;
    if (kind === "owner") {
      status = "ready";
      approvedBy = actor.agentId;
    } else if (kind === "agent") {
      if (actor.trustedCreator) {
        status = "ready";
        approvedBy = actor.agentId;
      } else if (actor.agent.createPolicy === "direct") status = "ready";
      await rateLimit(db, actor, status === "triage");
    } else if (keeperFields?.origin === "recurrence") {
      status = "ready";
      approvedBy = recurrenceApprover;
    }

    const project = data.projectRef
      ? await resolveProject(db, ownerId, data.projectRef)
      : null;
    const parentId = data.parentRef
      ? await parentFor(
          db,
          actor,
          data.parentRef,
          kind === "agent" &&
            (data.origin === "subtask" || data.origin === "handoff"),
        )
      : null;
    const contextPages = await resolvePages(
      db,
      ownerId,
      data.contextPageRefs ?? [],
    );
    if (ownerFields?.delegateAgentId)
      await agentExists(db, ownerId, ownerFields.delegateAgentId);
    const source = keeperFields?.sourcePageRef
      ? (await resolvePages(db, ownerId, [keeperFields.sourcePageRef]))[0]
      : null;
    const due = dueColumns(data.due);
    const { rows } = await db.query(
      `INSERT INTO brain_tasks (owner_id, number, title, description, acceptance_criteria, expected_output,
         status, priority, due_kind, due_on, due_at, due_text, requires_human, review_policy,
         delegate_agent_id, required_capability, project_page_id, parent_task_id, origin, owner_quote,
         created_by_agent_id, approved_at, approved_by_agent_id, idempotency_key, idempotency_fingerprint,
         batch_id, extraction_fingerprint, recurrence_id, occurrence_on)
       VALUES ($1,
         (SELECT greatest(
            coalesce((SELECT max(number) FROM brain_tasks WHERE owner_id = $1), 0),
            coalesce((SELECT max((payload->>'number')::int) FROM brain_task_events WHERE owner_id = $1 AND action = 'purged'), 0)) + 1),
         $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
         CASE WHEN $21::uuid IS NULL THEN NULL ELSE now() END, $21, $22, $23, $24, $25, $26, $27)
       RETURNING id, number`,
      [
        ownerId,
        data.title,
        data.description ?? "",
        data.acceptanceCriteria ?? [],
        expectedOutput,
        status,
        data.priority ?? DEFAULT_TASK_PRIORITY,
        due.due_kind,
        due.due_on,
        due.due_at,
        due.due_text,
        ownerFields?.requiresHuman ?? false,
        reviewPolicy,
        ownerFields?.delegateAgentId ?? null,
        ownerFields?.requiredCapability ?? null,
        project?.id ?? null,
        parentId,
        data.origin,
        data.ownerQuote ?? null,
        actor.agentId,
        approvedBy,
        idempotencyKey,
        idempotencyFingerprint,
        keeperFields?.batchId ?? null,
        keeperFields?.extractionFingerprint ?? null,
        keeperFields?.recurrenceId ?? null,
        keeperFields?.occurrenceOn ?? null,
      ],
    );
    const taskId = rows[0].id as string;
    const origin = linkOrigin(actor);
    const mentioned = await existingPageIds(
      db,
      ownerId,
      mentionedPageRefs(data.description ?? "").filter(
        (ref) => !contextPages.some((page) => page.ref === ref),
      ),
    );
    // The keeper writes only its source link; context comes from the conciliator.
    const links: LinkWrite[] =
      origin === "task_keeper"
        ? []
        : [
            ...contextLinks(contextPages, origin),
            ...contextLinks(
              mentioned.filter(
                (page) =>
                  !contextPages.some((context) => context.id === page.id),
              ),
              origin,
              true,
            ),
          ];
    if (source)
      links.push({
        pageId: source.id,
        role: "source",
        origin: "task_keeper",
        status: "active",
        evidence: {
          basis: "extraction",
          pageVersion: keeperFields?.sourceVersion ?? source.version,
          ...(keeperFields?.sourceExcerpt ?? {}),
        },
      });
    await upsertTaskLinks(db, ownerId, taskId, actor.agentId, links);
    await recordEvent(db, {
      ownerId,
      taskId,
      actorAgentId: actor.agentId,
      action: "created",
      toStatus: status,
      payload: {
        origin: data.origin,
        approved: approvedBy !== null,
        ...(data.due?.sourceExcerpt
          ? { dueSourceExcerpt: data.due.sourceExcerpt }
          : {}),
        ...(keeperFields?.batchId ? { batchId: keeperFields.batchId } : {}),
      },
    });
    return { taskId, replayed: false };
  });

  if (!outcome.replayed)
    await runDerivedLinks(ownerId, outcome.taskId, actor.agentId, "created");
  const db = getPool();
  const task = taskView(await loadTaskRow(db, ownerId, outcome.taskId));
  const [linked, duplicates] = await Promise.all([
    listTaskLinks(db, ownerId, outcome.taskId),
    outcome.replayed
      ? Promise.resolve([])
      : possibleDuplicates(ownerId, {
          id: outcome.taskId,
          title: task.title.value,
          projectId: task.project?.id ?? null,
        }),
  ]);
  return {
    task,
    status: task.status,
    approved: task.approved,
    replayed: outcome.replayed,
    possibleDuplicates: duplicates,
    linked,
    nextActions: creationNextActions(task, actor, duplicates),
  };
}

const CONTENT_FIELDS = [
  "title",
  "description",
  "acceptanceCriteria",
  "priority",
  "due",
  "projectRef",
  "parentRef",
  "expectedOutput",
  "reviewPolicy",
  "requiresHuman",
  "requiredCapability",
] as const;

async function assertParentAcyclic(
  db: Database,
  ownerId: string,
  taskId: string,
  parentId: string,
) {
  const { rows } = await db.query(
    `WITH RECURSIVE chain(id, depth) AS (
       SELECT $2::uuid, 0
       UNION
       SELECT t.parent_task_id, c.depth + 1 FROM brain_tasks t JOIN chain c ON t.id = c.id
       WHERE t.owner_id = $1 AND t.parent_task_id IS NOT NULL AND c.depth < 100
     ) SELECT EXISTS (SELECT 1 FROM chain WHERE id = $3) AS cycle`,
    [ownerId, parentId, taskId],
  );
  if (rows[0].cycle)
    throw taskError(
      "INVALID_INPUT",
      "A task cannot be its own ancestor.",
      "Choose a parent outside this task's subtasks.",
    );
}

/**
 * Edits a task. The owner edits anything; a creator edits its own task until
 * the owner approves it; the holder may only add or remove context pages.
 */
export async function updateTask(actor: Actor, input: unknown) {
  assertOwner(actor.ownerId);
  const ownerId = actor.ownerId;
  const owner = isOwnerActor(actor);
  if (actor.agent.kind === "system")
    throw taskError(
      "NOT_ALLOWED",
      "Nightly processes never edit tasks.",
      "Propose changes as suggestions for the owner.",
    );
  const data = owner
    ? parseTaskInput(ownerUpdateTaskSchema, input)
    : parseTaskInput(updateTaskSchema, input);
  const patch = data.patch as ReturnType<
    typeof ownerUpdateTaskSchema.parse
  >["patch"];
  const result = await transaction(async (db) => {
    const task = await lockTask(db, ownerId, data.ref);
    assertVersion(task, data.expectedVersion);
    const touched = CONTENT_FIELDS.filter((key) => patch[key] !== undefined);
    const isCreator = task.created_by_agent_id === actor.agentId;
    const isHolder =
      task.claimed_by_agent_id === actor.agentId && task.lease_id !== null;
    const ownUnapproved = isCreator && task.approved_at === null;
    const terminal = task.status === "done" || task.status === "canceled";
    if (!owner) {
      if (touched.length && (!ownUnapproved || terminal))
        throw taskError(
          "NOT_ALLOWED",
          isHolder
            ? `As the holder of ${task.ref} you cannot redefine its content.`
            : `Only the owner can edit ${task.ref} now.`,
          "Put findings in report_task notes or contextPageRefs, or ask the owner to edit the task in the app.",
          { ref: task.ref, fields: touched },
        );
      if (
        patch.status === "canceled" &&
        !(
          ownUnapproved &&
          task.claimed_by_agent_id === null &&
          (task.status === "triage" || task.status === "ready")
        )
      )
        throw taskError(
          "NOT_ALLOWED",
          `You cannot cancel ${task.ref}.`,
          "Agents cancel only their own tasks that are neither approved nor claimed; release a claim first, or ask the owner.",
          { ref: task.ref },
        );
      if (patch.contextPageRefs && !ownUnapproved && !isHolder)
        throw taskError(
          "NOT_ALLOWED",
          `Only the creator, the holder or the owner change ${task.ref}'s context pages.`,
          "Claim the task first, or mention the pages in your report.",
          { ref: task.ref },
        );
    }
    const sets: Record<string, unknown> = {};
    const changed: string[] = [];
    const set = (field: string, columns: Record<string, unknown>) => {
      Object.assign(sets, columns);
      changed.push(field);
    };
    if (patch.title !== undefined && patch.title !== task.title)
      set("title", { title: patch.title });
    if (patch.description !== undefined)
      set("description", { description: patch.description });
    if (patch.acceptanceCriteria !== undefined)
      set("acceptanceCriteria", {
        acceptance_criteria: patch.acceptanceCriteria,
      });
    if (patch.priority !== undefined)
      set("priority", { priority: patch.priority });
    if (patch.due !== undefined) set("due", dueColumns(patch.due));
    if (patch.projectRef === null) set("project", { project_page_id: null });
    else if (patch.projectRef !== undefined)
      set("project", {
        project_page_id: (await resolveProject(db, ownerId, patch.projectRef))
          .id,
      });
    else if (task.project_page_id && task.project_is_project === false)
      set("project", { project_page_id: null });
    if (patch.parentRef === null) set("parent", { parent_task_id: null });
    else if (patch.parentRef !== undefined) {
      const parentId = await parentFor(db, actor, patch.parentRef, false);
      if (parentId === task.id)
        throw taskError(
          "INVALID_INPUT",
          "A task cannot be its own parent.",
          "Choose another parent.",
        );
      await assertParentAcyclic(db, ownerId, task.id, parentId);
      set("parent", { parent_task_id: parentId });
    }
    const expected = (patch.expectedOutput ?? task.expected_output) as string;
    let policy = patch.reviewPolicy ?? task.review_policy;
    if ((OWNER_REVIEWED_OUTPUTS as readonly string[]).includes(expected)) {
      if (patch.reviewPolicy === "auto")
        throw taskError(
          "INVALID_INPUT",
          "Decisions and external actions are always reviewed by the owner.",
          "Keep reviewPolicy owner for this expected output.",
        );
      policy = "owner";
    }
    if (patch.expectedOutput !== undefined)
      set("expectedOutput", { expected_output: patch.expectedOutput });
    if (policy !== task.review_policy)
      set("reviewPolicy", { review_policy: policy });
    if (patch.requiresHuman !== undefined)
      set("requiresHuman", { requires_human: patch.requiresHuman });
    if (patch.requiredCapability !== undefined)
      set("requiredCapability", {
        required_capability: patch.requiredCapability,
      });
    const canceling = patch.status === "canceled" && task.status !== "canceled";
    if (canceling)
      Object.assign(sets, {
        status: "canceled",
        blocked_reason: null,
        ...CLEARED_LEASE,
      });
    if (changed.length || canceling)
      await updateTaskRow(db, ownerId, task.id, sets, [
        "version = version + 1",
      ]);
    if (changed.length)
      await recordEvent(db, {
        ownerId,
        taskId: task.id,
        actorAgentId: actor.agentId,
        action: "edited",
        payload: { changedFields: changed },
      });
    if (canceling) {
      await recordEvent(db, {
        ownerId,
        taskId: task.id,
        actorAgentId: actor.agentId,
        action: "status_changed",
        fromStatus: task.status,
        toStatus: "canceled",
      });
      if (owner) await rememberRejectedExtraction(db, ownerId, task);
    }
    const origin = owner ? "owner" : "agent";
    const linkChanges: Record<string, unknown> = {};
    const addPages = await resolvePages(
      db,
      ownerId,
      patch.contextPageRefs?.add ?? [],
    );
    const mentions =
      patch.description !== undefined
        ? (
            await existingPageIds(
              db,
              ownerId,
              mentionedPageRefs(patch.description),
            )
          ).filter((page) => !addPages.some((added) => added.id === page.id))
        : [];
    const added = [
      ...contextLinks(addPages, origin),
      ...contextLinks(mentions, origin, true),
    ];
    if (added.length) {
      await upsertTaskLinks(db, ownerId, task.id, actor.agentId, added, owner);
      linkChanges.added = added.map((link) => link.pageId);
    }
    const remove = patch.contextPageRefs?.remove ?? [];
    if (remove.length) {
      const pages = await resolvePages(db, ownerId, remove);
      const removed = await removeContextLinks(
        db,
        ownerId,
        task.id,
        actor.agentId,
        pages.map((page) => page.id),
        owner,
      );
      if (removed) linkChanges.removed = pages.map((page) => page.id);
    }
    if (Object.keys(linkChanges).length)
      await recordEvent(db, {
        ownerId,
        taskId: task.id,
        actorAgentId: actor.agentId,
        action: "links_changed",
        payload: linkChanges,
      });
    return {
      taskId: task.id,
      changedFields: [
        ...changed,
        ...(canceling ? ["status"] : []),
        ...(Object.keys(linkChanges).length ? ["contextPageRefs"] : []),
      ],
      contentChanged: changed.some((field) =>
        ["title", "description", "acceptanceCriteria", "project"].includes(
          field,
        ),
      ),
    };
  });
  if (result.contentChanged)
    await runDerivedLinks(ownerId, result.taskId, actor.agentId, "updated");
  return {
    task: taskView(await loadTaskRow(getPool(), ownerId, result.taskId)),
    changedFields: result.changedFields,
  };
}

/** A rejected or purged extraction never returns from the task keeper. */
export async function rememberRejectedExtraction(
  db: Database,
  ownerId: string,
  task: Pick<LockedTask, "extraction_fingerprint" | "id">,
) {
  if (!task.extraction_fingerprint) return;
  await db.query(
    `INSERT INTO brain_task_extraction_rejections (owner_id, fingerprint, source_page_id)
     SELECT $1, $2, (SELECT page_id FROM brain_task_links
                     WHERE owner_id = $1 AND task_id = $3 AND role = 'source' ORDER BY created_at LIMIT 1)
     ON CONFLICT (owner_id, fingerprint) DO NOTHING`,
    [ownerId, task.extraction_fingerprint, task.id],
  );
}

function readNextActions(
  task: TaskView,
  actor: Actor,
  holder: boolean,
): NextAction[] {
  const actions: NextAction[] = [];
  if (holder && task.status === "needs_input") {
    actions.push(
      {
        kind: "tool",
        tool: "read_task",
        args: { ref: task.ref },
        reason: `Poll every ${POLL_AFTER_SECONDS} seconds or later for the answer; you keep the claim meanwhile.`,
      },
      {
        kind: "tool",
        tool: "release_task",
        args: { ref: task.ref },
        reason: "Release the task instead of waiting for the owner's answer.",
      },
    );
  } else if (holder) {
    actions.push(
      {
        kind: "tool",
        tool: "report_task",
        args: { ref: task.ref },
        reason: "Report progress before reportBy to keep the lease.",
      },
      {
        kind: "tool",
        tool: "complete_task",
        args: { ref: task.ref },
        reason: "Complete with summary, criteria, pagesChanged and artifacts.",
      },
    );
  } else if (
    actor.agent.kind === "agent" &&
    (task.status === "ready" || task.status === "triage")
  ) {
    actions.push({
      kind: "tool",
      tool: "claim_task",
      args: { ref: task.ref },
      reason: "Claim before working; never work a task you do not hold.",
    });
  }
  if (!task.approved && task.status === "triage")
    actions.push(
      ownerAction(
        task.ref,
        "approve",
        `The owner approves ${task.ref} in the app.`,
      ),
    );
  if (task.status === "needs_input")
    actions.push(
      ownerAction(
        task.ref,
        "answer",
        `The owner answers ${task.ref}'s question in the app.`,
      ),
    );
  if (task.status === "in_review")
    actions.push(
      ownerAction(
        task.ref,
        "review",
        `The owner reviews ${task.ref} in the app.`,
      ),
    );
  if (task.status === "blocked")
    actions.push(
      ownerAction(
        task.ref,
        "unblock",
        `The owner unblocks ${task.ref} in the app.`,
      ),
    );
  return actions;
}

async function dependencyView(db: Database, ownerId: string, taskId: string) {
  const { rows } = await db.query(
    `SELECT 'blockedBy' AS direction, b.number, b.status FROM brain_task_dependencies d
       JOIN brain_tasks b ON b.owner_id = d.owner_id AND b.id = d.depends_on_task_id
       WHERE d.owner_id = $1 AND d.task_id = $2
     UNION ALL
     SELECT 'blocks', b.number, b.status FROM brain_task_dependencies d
       JOIN brain_tasks b ON b.owner_id = d.owner_id AND b.id = d.task_id
       WHERE d.owner_id = $1 AND d.depends_on_task_id = $2
     ORDER BY 1, 2`,
    [ownerId, taskId],
  );
  const pick = (direction: string) =>
    rows
      .filter((row) => row.direction === direction)
      .map((row) => ({ ref: formatTaskRef(row.number), status: row.status }));
  return { blockedBy: pick("blockedBy"), blocks: pick("blocks") };
}

/** Brief input for a task: project, linked pages and its notes. */
export async function briefForTask(
  ownerId: string,
  task: TaskView,
): Promise<TaskBrief> {
  const db = getPool();
  const [links, events] = await Promise.all([
    listTaskLinks(db, ownerId, task.id),
    briefEvents(db, ownerId, task.id),
  ]);
  return buildTaskBrief({
    ownerId,
    ref: task.ref,
    title: task.title.value,
    acceptanceCriteria: task.acceptanceCriteria.value,
    projectPageId: task.project?.isProject ? task.project.id : null,
    linkedPageIds: links
      .filter((link) => link.role !== "produced" || link.status === "active")
      .map((link) => link.page.id),
    links: links.map((link) => ({
      pageId: link.page.id,
      slug: link.page.slug,
      title: link.page.title,
      role: link.role,
      origin: link.origin,
      status: link.status,
      confidence: link.confidence,
      basis:
        typeof link.evidence.basis === "string" ? link.evidence.basis : null,
    })),
    history: events
      .filter(
        (event) =>
          event.note &&
          ["asked", "answered", "released", "reviewed", "reported"].includes(
            event.action,
          ),
      )
      .map((event) => ({
        action: event.action,
        note: event.note as string,
        authoredBy: event.actor.label,
        untrusted: event.untrusted,
        createdAt: event.createdAt,
      })),
  });
}

/** One task with links, parties, dependencies and recent history. */
export async function readTask(actor: Actor, input: unknown) {
  assertOwner(actor.ownerId);
  const ownerId = actor.ownerId;
  const data = parseTaskInput(readTaskSchema, input);
  const loaded = await transaction(async (db) => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const row = await loadTaskRow(db, ownerId, data.ref);
    const holder = await db.query(
      "SELECT claimed_by_agent_id = $3 AND lease_id IS NOT NULL AS holder FROM brain_tasks WHERE owner_id = $1 AND id = $2",
      [ownerId, row.id, actor.agentId],
    );
    // One client runs one query at a time: read the snapshot sequentially.
    const links = await listTaskLinks(db, ownerId, row.id);
    const parties = await listTaskParties(db, ownerId, row.id);
    const dependencies = await dependencyView(db, ownerId, row.id);
    const events = await recentEvents(db, ownerId, row.id, data.eventsLimit);
    const ownerAnswer = await latestOwnerAnswer(db, ownerId, row.id);
    return {
      task: taskView(row),
      holder: Boolean(holder.rows[0]?.holder),
      creator: row.created_by_agent_id === actor.agentId,
      links,
      parties,
      dependencies,
      events,
      ownerAnswer,
    };
  });
  const brief = data.includeBrief
    ? await briefForTask(ownerId, loaded.task)
    : undefined;
  return {
    task: loaded.task,
    links: loaded.links,
    parties: partiesForAgents(loaded.parties),
    dependencies: loaded.dependencies,
    events: loaded.events,
    ownerAnswer: loaded.ownerAnswer,
    you: { holder: loaded.holder, creator: loaded.creator },
    ...(brief ? { brief } : {}),
    nextActions: readNextActions(loaded.task, actor, loaded.holder),
  };
}

// The cursor carries the first page's event watermark: every page of one
// scan filters changedSince and returns eventsCursor at the same point, so a
// task that changes between pages behind the cursor is reported next scan.
function encodeCursor(row: QueryResultRow, watermark: string): string {
  return Buffer.from(
    JSON.stringify([row.priority, row.due_key, row.number, watermark]),
  ).toString("base64url");
}

function decodeCursor(cursor: string): {
  key: [number, string, number];
  watermark: string;
} {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      Array.isArray(value) &&
      value.length === 4 &&
      Number.isInteger(value[0]) &&
      typeof value[1] === "string" &&
      /^(\d{4}-\d{2}-\d{2}|infinity)$/.test(value[1]) &&
      Number.isInteger(value[2]) &&
      typeof value[3] === "string" &&
      /^\d{1,20}$/.test(value[3])
    )
      return {
        key: [value[0], value[1], value[2]],
        watermark: value[3],
      };
  } catch {}
  throw taskError(
    "INVALID_INPUT",
    "The list cursor is invalid.",
    "Pass nextCursor exactly as a previous list_tasks returned it.",
  );
}

/**
 * Lists tasks in queue order (priority, due date, number). `claimable` uses
 * the claim_task{next} predicate for the caller, including dependencies.
 */
export async function listTasks(actor: Actor, input: unknown) {
  assertOwner(actor.ownerId);
  const ownerId = actor.ownerId;
  const data = parseTaskInput(listTasksSchema, input);
  const db = getPool();
  const cursor = data.cursor ? decodeCursor(data.cursor) : null;
  const current = await eventWatermark(db);
  // Never past the current watermark: a forged later value would release
  // events of transactions that have not committed yet.
  const watermark =
    cursor && BigInt(cursor.watermark) < BigInt(current)
      ? cursor.watermark
      : current;
  const params: unknown[] = [ownerId];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = ["t.owner_id = $1", "t.archived_at IS NULL"];
  if (data.ref) {
    const ref = refCondition(data.ref, params.length + 1);
    params.push(...ref.params);
    where.push(ref.sql);
  }
  const statuses = data.status ?? (data.ref ? undefined : OPEN_TASK_STATUSES);
  if (statuses) where.push(`t.status = ANY(${add(statuses)}::text[])`);
  if (data.projectRef)
    where.push(
      `t.project_page_id = ${add((await resolveProject(db, ownerId, data.projectRef)).id)}`,
    );
  if (data.mine) where.push(`t.claimed_by_agent_id = ${add(actor.agentId)}`);
  if (data.claimable) {
    if (actor.agent.kind !== "agent") where.push("false");
    else
      where.push(
        queuePredicate(add(actor.agentId), add(actor.agent.capabilities)),
      );
  }
  if (data.query) {
    const query = add(data.query);
    const like = add(`%${escapeLike(data.query)}%`);
    where.push(
      `(t.search_document @@ websearch_to_tsquery('simple', ${query}) OR t.title ILIKE ${like} OR t.description ILIKE ${like})`,
    );
  }
  let removed: string[] = [];
  if (data.changedSince) {
    const since = parseEventCursor(data.changedSince);
    const tx = add(since.tx);
    const id = add(since.id);
    const mark = add(watermark);
    where.push(
      `EXISTS (SELECT 1 FROM brain_task_events e WHERE e.owner_id = t.owner_id AND e.task_id = t.id
         AND (e.tx, e.id) > (${tx}::xid8, ${id}::bigint) AND e.tx < ${mark}::xid8)`,
    );
    const purged = await db.query(
      `SELECT DISTINCT (payload->>'number')::int AS number FROM brain_task_events
       WHERE owner_id = $1 AND action = 'purged' AND (tx, id) > ($2::xid8, $3::bigint) AND tx < $4::xid8`,
      [ownerId, since.tx, since.id, watermark],
    );
    removed = purged.rows.map((row) => formatTaskRef(row.number));
  }
  if (cursor) {
    const [priority, dueKey, number] = cursor.key;
    where.push(
      `(t.priority, COALESCE(t.due_on, (t.due_at AT TIME ZONE 'Europe/Rome')::date, 'infinity'::date), t.number) > (${add(priority)}::smallint, ${add(dueKey)}::date, ${add(number)}::int)`,
    );
  }
  const { rows } = await db.query(
    `${TASK_VIEW_SELECT} WHERE ${where.join(" AND ")}
     ORDER BY t.priority, COALESCE(t.due_on, (t.due_at AT TIME ZONE 'Europe/Rome')::date, 'infinity'::date), t.number
     LIMIT ${data.limit + 1}`,
    params,
  );
  const page = rows.slice(0, data.limit);
  // Holders polling list_tasks{mine} see the owner's answer to their question.
  const withAnswers: (TaskListRow & {
    ownerAnswer?: Awaited<ReturnType<typeof latestOwnerAnswer>>;
  })[] = await Promise.all(
    page.map(async (row) => {
      const task = taskListRow(row);
      return data.mine &&
        (task.status === "in_progress" || task.status === "needs_input")
        ? {
            ...task,
            ownerAnswer: await latestOwnerAnswer(db, ownerId, task.id),
          }
        : task;
    }),
  );
  return {
    tasks: withAnswers,
    nextCursor:
      rows.length > data.limit
        ? encodeCursor(page[page.length - 1], watermark)
        : null,
    eventsCursor: formatEventCursor({ tx: watermark, id: "0" }),
    ...(data.changedSince ? { removed } : {}),
    pollAfterSeconds: POLL_AFTER_SECONDS,
  };
}

/** The owner's ready queue: approved, unassigned-to-humans work agents can take. */
export async function listReadyQueue(
  ownerId: string,
  options: { limit?: number; projectId?: string } = {},
) {
  assertOwner(ownerId);
  const params: unknown[] = [ownerId, Math.min(options.limit ?? 50, 200)];
  if (options.projectId) params.push(options.projectId);
  const project = options.projectId ? "AND t.project_page_id = $3" : "";
  const { rows } = await getPool().query(
    `${TASK_VIEW_SELECT}
     WHERE t.owner_id = $1 AND t.archived_at IS NULL AND t.status = 'ready'
       AND t.approved_at IS NOT NULL AND NOT t.requires_human ${project}
       AND NOT ${HUMAN_LEAD} AND NOT ${PROJECT_PAUSED} AND NOT ${OPEN_BLOCKERS}
     ORDER BY ${QUEUE_ORDER}
     LIMIT $2`,
    params,
  );
  return rows.map(taskListRow);
}
