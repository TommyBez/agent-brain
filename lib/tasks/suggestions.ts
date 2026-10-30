import { assertOwner } from "../brain/utils";
import { getPool, transaction } from "../db";
import type { Actor } from "./actors";
import { parseTaskInput, taskError } from "./errors";
import { recordEvent } from "./events";
import { assertOwnerActor } from "./mutations";
import { resolvePages, upsertTaskLinks } from "./page-links";
import { iso, lockTask, refCondition } from "./records";
import {
  linkDecisionSchema,
  ownerLinkSchema,
  suggestionDecisionSchema,
} from "./schemas";
import { formatTaskRef, type TaskSuggestionStatus } from "./types";

// Owner decisions on machine proposals: task keeper suggestions and
// suggested links. Nothing here is reachable from MCP.

export async function listTaskSuggestions(
  ownerId: string,
  options: {
    taskRef?: string;
    status?: TaskSuggestionStatus;
    limit?: number;
  } = {},
) {
  assertOwner(ownerId);
  const params: unknown[] = [
    ownerId,
    options.status ?? "open",
    Math.min(options.limit ?? 50, 200),
  ];
  let filter = "";
  if (options.taskRef) {
    const ref = refCondition(options.taskRef, 4);
    params.push(...ref.params);
    filter = `AND ${ref.sql}`;
  }
  const { rows } = await getPool().query(
    `SELECT s.id, s.kind, s.status, s.citations, s.confidence, s.policy_version, s.payload,
       s.created_at, s.decided_at, t.number, related.number AS related_number
     FROM brain_task_suggestions s
     JOIN brain_tasks t ON t.owner_id = s.owner_id AND t.id = s.task_id
     LEFT JOIN brain_tasks related ON related.owner_id = s.owner_id AND related.id = s.related_task_id
     WHERE s.owner_id = $1 AND s.status = $2 ${filter}
     ORDER BY s.created_at DESC, s.id LIMIT $3`,
    params,
  );
  return rows.map((row) => ({
    id: row.id as string,
    ref: formatTaskRef(row.number),
    relatedRef: row.related_number ? formatTaskRef(row.related_number) : null,
    kind: row.kind as string,
    status: row.status as string,
    citations: row.citations,
    confidence: row.confidence as number | null,
    policyVersion: row.policy_version as string,
    /** The prefilled transition the owner executes on acceptance. */
    payload: row.payload as Record<string, unknown>,
    createdAt: iso(row.created_at) as string,
    decidedAt: iso(row.decided_at),
  }));
}

/**
 * Accepting records the decision and returns the prefilled transition; the
 * app then runs that transition as the owner. Dismissed suggestions never return.
 */
export async function decideTaskSuggestion(actor: Actor, input: unknown) {
  assertOwnerActor(actor);
  const data = parseTaskInput(suggestionDecisionSchema, input);
  const { rows } = await getPool().query(
    `UPDATE brain_task_suggestions SET status = $3, decided_by_agent_id = $4, decided_at = now(), updated_at = now()
     WHERE owner_id = $1 AND id = $2 AND status = 'open'
     RETURNING id, kind, status, payload, task_id`,
    [actor.ownerId, data.id, data.decision, actor.agentId],
  );
  if (!rows[0])
    throw taskError(
      "SUGGESTION_NOT_FOUND",
      "That suggestion is not open.",
      "Reload Needs you; it may have been decided or expired.",
    );
  return {
    id: rows[0].id as string,
    kind: rows[0].kind as string,
    status: rows[0].status as string,
    payload: rows[0].payload as Record<string, unknown>,
  };
}

/** Accept or reject a suggested link; a rejection is final for (task, page, role). */
export async function decideTaskLink(
  actor: Actor,
  taskRef: string,
  input: unknown,
) {
  assertOwnerActor(actor);
  const data = parseTaskInput(linkDecisionSchema, input);
  return transaction(async (db) => {
    const task = await lockTask(db, actor.ownerId, taskRef);
    const [page] = await resolvePages(db, actor.ownerId, [data.pageRef]);
    const { rows } = await db.query(
      `UPDATE brain_task_links SET status = $5, decided_by_agent_id = $6, decided_at = now(), updated_at = now()
       WHERE owner_id = $1 AND task_id = $2 AND page_id = $3 AND role = $4
       RETURNING status`,
      [
        actor.ownerId,
        task.id,
        page.id,
        data.role,
        data.decision,
        actor.agentId,
      ],
    );
    if (!rows[0])
      throw taskError(
        "LINK_NOT_FOUND",
        "That link does not exist on this task.",
        "Reload the task and decide one of its listed links.",
      );
    await recordEvent(db, {
      ownerId: actor.ownerId,
      taskId: task.id,
      actorAgentId: actor.agentId,
      action: "links_changed",
      payload: {
        decided: { pageId: page.id, role: data.role, status: data.decision },
      },
    });
    return {
      ref: task.ref,
      pageId: page.id,
      role: data.role,
      status: data.decision,
    };
  });
}

/** The owner links a page directly (active, origin owner). */
export async function addTaskLink(
  actor: Actor,
  taskRef: string,
  input: unknown,
) {
  assertOwnerActor(actor);
  const data = parseTaskInput(ownerLinkSchema, input);
  return transaction(async (db) => {
    const task = await lockTask(db, actor.ownerId, taskRef);
    const [page] = await resolvePages(db, actor.ownerId, [data.pageRef]);
    const [link] = await upsertTaskLinks(
      db,
      actor.ownerId,
      task.id,
      actor.agentId,
      [
        {
          pageId: page.id,
          role: data.role,
          origin: "owner",
          status: "active",
          evidence: { basis: "reference", pageVersion: page.version },
        },
      ],
      true,
    );
    await recordEvent(db, {
      ownerId: actor.ownerId,
      taskId: task.id,
      actorAgentId: actor.agentId,
      action: "links_changed",
      payload: { added: [page.id], role: data.role },
    });
    return { ref: task.ref, ...link };
  });
}
