import type { Database } from "../brain/pages";
import { getPool, transaction } from "../db";
import type { Actor } from "./actors";
import { parseTaskInput, taskError } from "./errors";
import { recordEvent } from "./events";
import { assertOwnerActor } from "./mutations";
import { resolvePages } from "./page-links";
import { type Author, authored, lockTask } from "./records";
import { partySchema } from "./schemas";

// Who else is involved: owner, agents, person pages or free groups ("tutti").
// A person or group lead keeps a task out of queue claims.

export interface TaskPartyView {
  id: string;
  role: string;
  kind: string;
  label: string;
  agentId: string | null;
  personPage: { id: string; slug: string } | null;
  groupLabel: string | null;
  sourceNote: string | null;
  /** Who added the party: the owner, or the task keeper transcribing a page. */
  createdBy: Author;
}

export async function listTaskParties(
  db: Database,
  ownerId: string,
  taskId: string,
): Promise<TaskPartyView[]> {
  const { rows } = await db.query(
    `SELECT p.id, p.role, p.kind, p.agent_id, p.person_page_id, p.group_label, p.source_note,
       a.label AS agent_label, pg.slug AS person_slug, pg.title AS person_title,
       c.label AS creator_label, c.kind AS creator_kind
     FROM brain_task_parties p
     LEFT JOIN brain_agents a ON a.owner_id = p.owner_id AND a.id = p.agent_id
     LEFT JOIN brain_pages pg ON pg.owner_id = p.owner_id AND pg.id = p.person_page_id
     JOIN brain_agents c ON c.owner_id = p.owner_id AND c.id = p.created_by_agent_id
     WHERE p.owner_id = $1 AND p.task_id = $2
     ORDER BY array_position(ARRAY['lead','support','reviewer','requester'], p.role), p.created_at, p.id`,
    [ownerId, taskId],
  );
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    kind: row.kind,
    label: row.agent_label ?? row.person_title ?? row.group_label,
    agentId: row.agent_id,
    personPage: row.person_page_id
      ? { id: row.person_page_id, slug: row.person_slug }
      : null,
    groupLabel: row.group_label,
    sourceNote: row.source_note,
    createdBy: { label: row.creator_label, kind: row.creator_kind },
  }));
}

/**
 * Parties as agents read them: labels, group names and source notes come from
 * whoever added the party (often transcribed from page text), so they are
 * marked untrusted unless the owner wrote them.
 */
export function partiesForAgents(parties: TaskPartyView[]) {
  return parties.map((party) => ({
    id: party.id,
    role: party.role,
    kind: party.kind,
    label: authored(party.label, party.createdBy),
    agentId: party.agentId,
    personPage: party.personPage,
    groupLabel:
      party.groupLabel === null
        ? null
        : authored(party.groupLabel, party.createdBy),
    sourceNote:
      party.sourceNote === null
        ? null
        : authored(party.sourceNote, party.createdBy),
  }));
}

function assertPartyWriter(actor: Actor) {
  if (actor.agent.kind === "owner" || actor.agent.systemKey === "task_keeper")
    return;
  throw taskError(
    "NOT_ALLOWED",
    "Only the owner (or the task keeper for its transcriptions) sets task parties.",
    "Ask the owner to change participants in the app.",
  );
}

/** Adds a participant; idempotent for the same role and member. */
export async function addTaskParty(
  actor: Actor,
  taskRef: string,
  input: unknown,
) {
  assertPartyWriter(actor);
  const data = parseTaskInput(partySchema, input);
  const ownerId = actor.ownerId;
  return transaction(async (db) => {
    const task = await lockTask(db, ownerId, taskRef);
    let agentId: string | null = null;
    let personPageId: string | null = null;
    if (data.kind === "owner") {
      const owner = await db.query(
        "SELECT id FROM brain_agents WHERE owner_id = $1 AND kind = 'owner'",
        [ownerId],
      );
      if (!owner.rows[0])
        throw taskError(
          "AGENT_NOT_FOUND",
          "The owner agent is not registered yet.",
          "Open the app once to register the owner.",
        );
      agentId = owner.rows[0].id;
    } else if (data.kind === "agent") {
      const agent = await db.query(
        "SELECT id FROM brain_agents WHERE owner_id = $1 AND id = $2 AND kind = 'agent'",
        [ownerId, data.agentId],
      );
      if (!agent.rows[0])
        throw taskError(
          "AGENT_NOT_FOUND",
          "That agent does not exist.",
          "Choose an agent from the /agents registry.",
        );
      agentId = agent.rows[0].id;
    } else if (data.kind === "person") {
      const [page] = await resolvePages(db, ownerId, [
        data.personPageRef as string,
      ]);
      if (page.type !== "person")
        throw taskError(
          "PAGE_NOT_FOUND",
          `${data.personPageRef} is not a person page.`,
          "Resolve the person first; unresolved names stay a group label, never an invented page.",
        );
      personPageId = page.id;
    }
    const { rows } = await db.query(
      `INSERT INTO brain_task_parties (owner_id, task_id, role, kind, agent_id, person_page_id, group_label, source_note, created_by_agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT ON CONSTRAINT brain_task_parties_member_key DO UPDATE SET source_note = coalesce(excluded.source_note, brain_task_parties.source_note)
       RETURNING id, (xmax = 0) AS inserted`,
      [
        ownerId,
        task.id,
        data.role,
        data.kind,
        agentId,
        personPageId,
        data.groupLabel ?? null,
        data.sourceNote ?? null,
        actor.agentId,
      ],
    );
    if (rows[0].inserted)
      await recordEvent(db, {
        ownerId,
        taskId: task.id,
        actorAgentId: actor.agentId,
        action: "edited",
        payload: {
          changedFields: ["parties"],
          party: { added: rows[0].id, role: data.role, kind: data.kind },
        },
      });
    return (await listTaskParties(db, ownerId, task.id)).find(
      (party) => party.id === rows[0].id,
    ) as TaskPartyView;
  });
}

export async function removeTaskParty(
  actor: Actor,
  taskRef: string,
  partyId: string,
) {
  assertOwnerActor(actor);
  const ownerId = actor.ownerId;
  return transaction(async (db) => {
    const task = await lockTask(db, ownerId, taskRef);
    const { rows } = await db.query(
      "DELETE FROM brain_task_parties WHERE owner_id = $1 AND task_id = $2 AND id = $3::uuid RETURNING role, kind",
      [ownerId, task.id, partyId],
    );
    if (!rows[0])
      throw taskError(
        "PARTY_NOT_FOUND",
        "That participant is not on this task.",
        "Reload the task and pick a listed participant.",
      );
    await recordEvent(db, {
      ownerId,
      taskId: task.id,
      actorAgentId: actor.agentId,
      action: "edited",
      payload: {
        changedFields: ["parties"],
        party: { removed: partyId, role: rows[0].role, kind: rows[0].kind },
      },
    });
    return { removed: true };
  });
}

export async function readTaskParties(ownerId: string, taskId: string) {
  return listTaskParties(getPool(), ownerId, taskId);
}
