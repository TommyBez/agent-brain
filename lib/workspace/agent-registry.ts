import { z } from "zod";
import { listAgentTokens } from "../agent-tokens";
import { BrainError } from "../brain/types";
import { assertOwner } from "../brain/utils";
import { getPool } from "../db";
import {
  type AgentPatch,
  type AgentSummary,
  type BrainAgent,
  listAgents,
  setAgentDisabled,
  updateAgent,
} from "../tasks/actors";
import { type AgentKind, formatTaskRef } from "../tasks/types";

// The /agents registry: agents with their credentials and current claims.
// Credential metadata stays uncached; callers must authenticate the owner.

export interface RegistryToken {
  id: string;
  name: string;
  prefix: string;
  active: boolean;
}

export interface RegistryAgent extends AgentSummary {
  tokens: RegistryToken[];
  /** trusted_creator applies to token requests only, never OAuth. */
  canBeTrustedCreator: boolean;
  /** Tasks it holds with a live lease or an open question. */
  claims: string[];
  /** Tasks whose lease ran out; another agent can reclaim them. */
  expiredClaims: string[];
}

export const REGISTRY_CLAIMS_SHOWN = 5;

export async function agentRegistry(ownerId: string): Promise<RegistryAgent[]> {
  assertOwner(ownerId);
  const [agents, tokens, claims] = await Promise.all([
    listAgents(ownerId),
    listAgentTokens(ownerId),
    getPool().query<{ agent_id: string; number: number; expired: boolean }>(
      `SELECT claimed_by_agent_id AS agent_id, number,
         (status = 'in_progress' AND lease_expires_at <= now()) AS expired
       FROM brain_tasks
       WHERE owner_id = $1 AND claimed_by_agent_id IS NOT NULL AND archived_at IS NULL
       ORDER BY claimed_at DESC, number DESC`,
      [ownerId],
    ),
  ]);
  const now = Date.now();
  return agents.map((agent) => {
    const own = tokens.filter((token) => token.agentId === agent.id);
    const held = claims.rows.filter((row) => row.agent_id === agent.id);
    return {
      ...agent,
      tokens: own.map((token) => ({
        id: token.id,
        name: token.name,
        prefix: token.prefix,
        active:
          !token.revokedAt &&
          (!token.expiresAt || token.expiresAt.getTime() > now),
      })),
      canBeTrustedCreator: agent.kind === "agent" && own.length > 0,
      claims: held
        .filter((row) => !row.expired)
        .map((row) => formatTaskRef(row.number)),
      expiredClaims: held
        .filter((row) => row.expired)
        .map((row) => formatTaskRef(row.number)),
    };
  });
}

/** Active ordinary agents a new token can be bound to. */
export function tokenAgentChoices(agents: readonly BrainAgent[]) {
  return agents
    .filter((agent) => agent.kind === "agent" && !agent.disabledAt)
    .map((agent) => ({ id: agent.id, label: agent.label }));
}

/**
 * Owner edits from /agents. Turning trusted_creator on needs a token bound to
 * the agent: an OAuth client id names shared software, not one worker.
 */
export async function updateRegistryAgent(
  ownerId: string,
  agentId: string,
  patch: AgentPatch,
): Promise<BrainAgent> {
  assertOwner(ownerId);
  if (!z.uuid().safeParse(agentId).success)
    throw new BrainError("AGENT_NOT_FOUND", "Agent not found.", 404);
  if (patch && typeof patch === "object" && patch.trustedCreator === true) {
    const { rowCount } = await getPool().query(
      "SELECT 1 FROM agent_tokens WHERE owner_id = $1 AND agent_id = $2::uuid LIMIT 1",
      [ownerId, agentId],
    );
    if (!rowCount)
      throw new BrainError(
        "NOT_ALLOWED",
        "Only agents with their own token can be trusted creators; OAuth clients cannot.",
        403,
      );
  }
  return updateAgent(ownerId, agentId, patch);
}

export function setRegistryAgentDisabled(
  ownerId: string,
  agentId: string,
  disabled: boolean,
): Promise<BrainAgent> {
  return setAgentDisabled(ownerId, agentId, disabled);
}

export interface RevisionActor {
  label: string;
  kind: AgentKind;
}

/**
 * Who signed the revisions in one history window (the same order, limit and
 * offset as listRevisionSummaries), or one version, keyed by version.
 * Revisions saved before agents were recorded have no entry.
 */
export async function revisionActors(
  ownerId: string,
  pageRef: string,
  window: { limit: number; offset: number } | { version: number },
): Promise<Record<number, RevisionActor>> {
  assertOwner(ownerId);
  const version = "version" in window ? window.version : null;
  const { rows } = await getPool().query<{
    version: number;
    label: string | null;
    kind: AgentKind | null;
  }>(
    `SELECT r.version, a.label, a.kind FROM brain_revisions r
     JOIN brain_pages p ON p.id = r.page_id AND p.owner_id = r.owner_id
     LEFT JOIN brain_agents a ON a.owner_id = r.owner_id AND a.id = r.actor_agent_id
     WHERE r.owner_id = $1 AND (p.id::text = $2 OR p.slug = $2)
       AND ($3::int IS NULL OR r.version = $3)
     ORDER BY r.version DESC LIMIT $4 OFFSET $5`,
    [
      ownerId,
      pageRef,
      version,
      "limit" in window ? window.limit : 1,
      "offset" in window ? window.offset : 0,
    ],
  );
  return Object.fromEntries(
    rows.flatMap((row) =>
      row.label && row.kind
        ? [[row.version, { label: row.label, kind: row.kind }]]
        : [],
    ),
  );
}
