import type { QueryResultRow } from "pg";
import { z } from "zod";
import { AuthError, type Principal } from "../auth-principal";
import type { Database } from "../brain/pages";
import { BrainError } from "../brain/types";
import { assertOwner } from "../brain/utils";
import { getPool, transaction } from "../db";
import { sanitizeTaskLine } from "./sanitize";
import {
  AGENT_CREATE_POLICIES,
  AGENT_LAST_SEEN_INTERVAL_MINUTES,
  AGENT_LIMITS,
  type AgentCreatePolicy,
  type AgentCredential,
  type AgentKind,
  effectiveClaimOnRequest,
  effectiveTrustedCreator,
  SYSTEM_AGENT_LABELS,
  type SystemAgentKey,
} from "./types";

export interface BrainAgent {
  id: string;
  kind: AgentKind;
  systemKey: SystemAgentKey | null;
  label: string;
  /** False while the label is a self-declared token or OAuth client name. */
  labelVerified: boolean;
  capabilities: string[];
  createPolicy: AgentCreatePolicy;
  trustedCreator: boolean;
  /** Owner override; NULL means the credential default. */
  claimOnRequest: boolean | null;
  personPageId: string | null;
  disabledAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

/** The agent behind one request or nightly process. */
export interface Actor {
  ownerId: string;
  agentId: string;
  agent: BrainAgent;
  credential: AgentCredential;
  tokenId?: string;
  clientId?: string;
  /** trusted_creator as it applies to this credential (token requests only). */
  trustedCreator: boolean;
  /** claim_on_request as it applies to this credential. */
  claimOnRequest: boolean;
}

export interface AgentSummary extends BrainAgent {
  clientIds: string[];
  activeTokenCount: number;
}

const COLUMNS =
  "id, kind, system_key, label, label_verified, capabilities, create_policy, trusted_creator, claim_on_request, person_page_id, disabled_at, last_seen_at, created_at";

const SELECTORS = {
  owner: "kind = 'owner'",
  system: "system_key = $2",
  token:
    "id = (SELECT agent_id FROM agent_tokens WHERE owner_id = $1 AND id = $2::uuid)",
  oauth:
    "id = (SELECT agent_id FROM brain_agent_clients WHERE owner_id = $1 AND client_id = $2)",
} as const;

const timestamp = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();

function agentFromRow(row: QueryResultRow): BrainAgent {
  return {
    id: row.id,
    kind: row.kind,
    systemKey: row.system_key,
    label: row.label,
    labelVerified: row.label_verified,
    capabilities: row.capabilities,
    createPolicy: row.create_policy,
    trustedCreator: row.trusted_creator,
    claimOnRequest: row.claim_on_request,
    personPageId: row.person_page_id,
    disabledAt: timestamp(row.disabled_at),
    lastSeenAt: timestamp(row.last_seen_at),
    createdAt: timestamp(row.created_at) as string,
  };
}

/**
 * The steady-state lookup: one statement that reads the agent and writes
 * last_seen_at only when it is empty or older than the throttle interval.
 */
async function touch(
  db: Database,
  ownerId: string,
  selector: keyof typeof SELECTORS,
  key?: string,
): Promise<BrainAgent | undefined> {
  const { rows } = await db.query(
    `WITH a AS (SELECT ${COLUMNS} FROM brain_agents WHERE owner_id = $1 AND ${SELECTORS[selector]}),
     touched AS (
       UPDATE brain_agents SET last_seen_at = now()
       WHERE owner_id = $1 AND id = (SELECT id FROM a)
         AND (last_seen_at IS NULL OR last_seen_at < now() - interval '${AGENT_LAST_SEEN_INTERVAL_MINUTES} minutes')
     )
     SELECT * FROM a`,
    key === undefined ? [ownerId] : [ownerId, key],
  );
  return rows[0] ? agentFromRow(rows[0]) : undefined;
}

function actor(
  ownerId: string,
  agent: BrainAgent,
  credential: AgentCredential,
  extra: { tokenId?: string; clientId?: string } = {},
): Actor {
  return {
    ownerId,
    agentId: agent.id,
    agent,
    credential,
    ...extra,
    trustedCreator: effectiveTrustedCreator(
      agent.kind,
      agent.trustedCreator,
      credential,
    ),
    claimOnRequest: effectiveClaimOnRequest(
      agent.kind,
      agent.claimOnRequest,
      credential,
    ),
  };
}

function missing(what: string): never {
  throw new Error(`The ${what} agent could not be provisioned.`);
}

function assertEnabled(agent: BrainAgent) {
  if (agent.disabledAt)
    throw new AuthError(
      "agent_disabled",
      "The owner has disabled this agent in Agent Brain.",
      403,
    );
}

/**
 * The owner's own agent (browser session, REST and Server Actions). Pass the
 * caller's READ COMMITTED transaction client to stamp writes inside it.
 */
export async function ownerActor(
  ownerId: string,
  db: Database = getPool(),
): Promise<Actor> {
  assertOwner(ownerId);
  let agent = await touch(db, ownerId, "owner");
  if (!agent) {
    await db.query(
      `INSERT INTO brain_agents (owner_id, kind, label, label_verified, last_seen_at)
       VALUES ($1, 'owner', left(coalesce(nullif(btrim((SELECT name FROM "user" WHERE id = $1)), ''), 'Owner'), ${AGENT_LIMITS.label}), true, now())
       ON CONFLICT (owner_id) WHERE kind = 'owner'::text DO NOTHING`,
      [ownerId],
    );
    agent = (await touch(db, ownerId, "owner")) ?? missing("owner");
  }
  return actor(ownerId, agent, "session");
}

/** A nightly process (consolidator, task keeper), registered on first use. */
export async function systemActor(
  ownerId: string,
  key: SystemAgentKey,
  db: Database = getPool(),
): Promise<Actor> {
  assertOwner(ownerId);
  let agent = await touch(db, ownerId, "system", key);
  if (!agent) {
    await db.query(
      `INSERT INTO brain_agents (owner_id, kind, system_key, label, label_verified, last_seen_at)
       VALUES ($1, 'system', $2, $3, true, now())
       ON CONFLICT (owner_id, system_key) WHERE system_key IS NOT NULL DO NOTHING`,
      [ownerId, key, SYSTEM_AGENT_LABELS[key]],
    );
    agent = (await touch(db, ownerId, "system", key)) ?? missing(key);
  }
  return actor(ownerId, agent, "system");
}

/**
 * A self-declared token or OAuth client name as an agent label: stripped of
 * invisible, bidirectional and control characters, one line, at most 80
 * characters, falling back to the given identifier.
 */
export function agentLabel(
  name: string | null | undefined,
  fallback: string,
): string {
  for (const value of [name ?? "", fallback]) {
    const label = Array.from(sanitizeTaskLine(value))
      .slice(0, AGENT_LIMITS.label)
      .join("")
      .trim();
    if (label) return label;
  }
  return "Agent";
}

// A legacy token gets its agent on first use, named after the token. The row
// lock makes a concurrent first use see the bound agent instead of a twin.
async function provisionTokenAgent(ownerId: string, tokenId: string) {
  const token = await getPool().query<{ name: string }>(
    "SELECT name FROM agent_tokens WHERE owner_id = $1 AND id = $2::uuid",
    [ownerId, tokenId],
  );
  await getPool().query(
    `WITH token AS (
       SELECT name FROM agent_tokens
       WHERE owner_id = $1 AND id = $2::uuid AND agent_id IS NULL FOR UPDATE
     ), created AS (
       INSERT INTO brain_agents (owner_id, kind, label, last_seen_at)
       SELECT $1, 'agent', $3, now() FROM token RETURNING id
     )
     UPDATE agent_tokens SET agent_id = created.id FROM created
     WHERE agent_tokens.owner_id = $1 AND agent_tokens.id = $2::uuid`,
    [ownerId, tokenId, agentLabel(token.rows[0]?.name, "Agent token")],
  );
}

// An OAuth client gets its agent on its first task tool call or write, named
// after the registered client (unverified) or its client_id.
async function provisionClientAgent(ownerId: string, clientId: string) {
  await transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      ownerId,
      `agent-client:${clientId}`,
    ]);
    // The client chose its own name (dynamic registration or CIMD).
    const client = await db.query<{ name: string | null }>(
      `SELECT name FROM "oauthClient" WHERE "clientId" = $1 LIMIT 1`,
      [clientId],
    );
    await db.query(
      `WITH created AS (
         INSERT INTO brain_agents (owner_id, kind, label, last_seen_at)
         SELECT $1, 'agent', $3, now()
         WHERE NOT EXISTS (SELECT 1 FROM brain_agent_clients WHERE owner_id = $1 AND client_id = $2)
         RETURNING id
       )
       INSERT INTO brain_agent_clients (owner_id, client_id, agent_id)
       SELECT $1, $2, id FROM created`,
      [ownerId, clientId, agentLabel(client.rows[0]?.name, clientId)],
    );
  });
}

/**
 * Resolves the agent of an authenticated request: session → owner, brain_
 * token → the token's agent, OAuth → the client's agent. Unknown agents are
 * registered on first use. Call it outside the caller's write transaction.
 */
export async function resolveActor(
  ownerId: string,
  principal: Principal,
): Promise<Actor> {
  assertOwner(ownerId);
  if (principal.ownerId !== ownerId)
    throw new AuthError(
      "forbidden",
      "This identity does not own this brain.",
      403,
    );
  if (principal.kind === "session") return ownerActor(ownerId);
  if (principal.kind === "token") {
    const tokenId = principal.tokenId;
    if (!tokenId)
      throw new AuthError(
        "invalid_token",
        "The agent token could not be identified.",
      );
    let agent = await touch(getPool(), ownerId, "token", tokenId);
    if (!agent) {
      await provisionTokenAgent(ownerId, tokenId);
      agent = await touch(getPool(), ownerId, "token", tokenId);
    }
    if (!agent)
      throw new AuthError(
        "invalid_token",
        "The agent token is invalid, expired, or revoked.",
      );
    assertEnabled(agent);
    return actor(ownerId, agent, "token", { tokenId });
  }
  const clientId = principal.clientId;
  if (!clientId || clientId.length > AGENT_LIMITS.clientId)
    throw new AuthError(
      "invalid_client",
      "The access token does not identify its OAuth client.",
      403,
    );
  let agent = await touch(getPool(), ownerId, "oauth", clientId);
  if (!agent) {
    await provisionClientAgent(ownerId, clientId);
    agent =
      (await touch(getPool(), ownerId, "oauth", clientId)) ?? missing(clientId);
  }
  assertEnabled(agent);
  return actor(ownerId, agent, "oauth", { clientId });
}

// Owner registry (/agents). Callers must authenticate the owner first.

export async function listAgents(ownerId: string): Promise<AgentSummary[]> {
  assertOwner(ownerId);
  const { rows } = await getPool().query(
    `SELECT ${COLUMNS},
       coalesce((SELECT array_agg(c.client_id ORDER BY c.client_id) FROM brain_agent_clients c
                 WHERE c.owner_id = a.owner_id AND c.agent_id = a.id), '{}'::text[]) AS client_ids,
       (SELECT count(*)::int FROM agent_tokens t
        WHERE t.owner_id = a.owner_id AND t.agent_id = a.id AND t.revoked_at IS NULL AND t.expires_at > now()) AS active_token_count
     FROM brain_agents a WHERE a.owner_id = $1
     ORDER BY array_position(ARRAY['owner','agent','system'], a.kind), a.disabled_at IS NOT NULL, lower(a.label), a.id
     LIMIT 500`,
    [ownerId],
  );
  return rows.map((row) => ({
    ...agentFromRow(row),
    clientIds: row.client_ids,
    activeTokenCount: row.active_token_count,
  }));
}

const capability = z
  .string()
  .trim()
  .min(1)
  .max(AGENT_LIMITS.capability)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}._:/@+-]*$/u);
const updateSchema = z
  .object({
    label: z
      .string()
      .transform(sanitizeTaskLine)
      .pipe(z.string().min(1).max(AGENT_LIMITS.label))
      .optional(),
    capabilities: z
      .array(capability)
      .max(AGENT_LIMITS.capabilities)
      .transform((values) => [...new Set(values)])
      .optional(),
    createPolicy: z.enum(AGENT_CREATE_POLICIES).optional(),
    trustedCreator: z.boolean().optional(),
    claimOnRequest: z.boolean().nullable().optional(),
    personPageId: z.uuid().nullable().optional(),
  })
  .strict();
export type AgentPatch = z.input<typeof updateSchema>;

/** Owner edits. Policies and capabilities apply only to ordinary agents. */
export async function updateAgent(
  ownerId: string,
  agentId: string,
  value: unknown,
): Promise<BrainAgent> {
  assertOwner(ownerId);
  const parsed = updateSchema.safeParse(value);
  if (!parsed.success || !z.uuid().safeParse(agentId).success)
    throw new BrainError(
      "INVALID_INPUT",
      "Provide a label of 1–80 characters, capabilities such as repo:agent-brain, and valid policies.",
    );
  const patch = parsed.data;
  return transaction(async (db) => {
    const current = await db.query<{ kind: AgentKind }>(
      "SELECT kind FROM brain_agents WHERE owner_id = $1 AND id = $2 FOR UPDATE",
      [ownerId, agentId],
    );
    if (!current.rows[0])
      throw new BrainError("AGENT_NOT_FOUND", "Agent not found.", 404);
    const policyFields = [
      patch.capabilities,
      patch.createPolicy,
      patch.trustedCreator,
      patch.claimOnRequest,
    ];
    if (
      current.rows[0].kind !== "agent" &&
      policyFields.some((field) => field !== undefined)
    )
      throw new BrainError(
        "NOT_ALLOWED",
        "Only connected agents have capabilities and task policies.",
        403,
      );
    if (patch.personPageId) {
      const page = await db.query(
        "SELECT 1 FROM brain_pages WHERE owner_id = $1 AND id = $2 AND type = 'person'",
        [ownerId, patch.personPageId],
      );
      if (!page.rowCount)
        throw new BrainError(
          "INVALID_PERSON_PAGE",
          "Choose an existing person page.",
        );
    }
    const { rows } = await db.query(
      `UPDATE brain_agents SET
         label = coalesce($3, label),
         label_verified = label_verified OR $3 IS NOT NULL,
         capabilities = coalesce($4::text[], capabilities),
         create_policy = coalesce($5, create_policy),
         trusted_creator = coalesce($6, trusted_creator),
         claim_on_request = CASE WHEN $7 THEN $8::boolean ELSE claim_on_request END,
         person_page_id = CASE WHEN $9 THEN $10::uuid ELSE person_page_id END
       WHERE owner_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
      [
        ownerId,
        agentId,
        patch.label ?? null,
        patch.capabilities ?? null,
        patch.createPolicy ?? null,
        patch.trustedCreator ?? null,
        patch.claimOnRequest !== undefined,
        patch.claimOnRequest ?? null,
        patch.personPageId !== undefined,
        patch.personPageId ?? null,
      ],
    );
    return agentFromRow(rows[0]);
  });
}

/**
 * Disable takes effect on the agent's next request. Only connected agents can
 * be disabled: the owner and the nightly system agents never are.
 */
export async function setAgentDisabled(
  ownerId: string,
  agentId: string,
  disabled: boolean,
): Promise<BrainAgent> {
  assertOwner(ownerId);
  if (!z.uuid().safeParse(agentId).success)
    throw new BrainError("AGENT_NOT_FOUND", "Agent not found.", 404);
  const { rows } = await getPool().query(
    `UPDATE brain_agents SET disabled_at = CASE WHEN $3 THEN coalesce(disabled_at, now()) END
     WHERE owner_id = $1 AND id = $2 AND kind = 'agent' RETURNING ${COLUMNS}`,
    [ownerId, agentId, disabled],
  );
  if (rows[0]) return agentFromRow(rows[0]);
  const exists = await getPool().query(
    "SELECT 1 FROM brain_agents WHERE owner_id = $1 AND id = $2",
    [ownerId, agentId],
  );
  if (exists.rowCount)
    throw new BrainError(
      "NOT_ALLOWED",
      "Only connected agents can be disabled; the owner and system processes cannot.",
      403,
    );
  throw new BrainError("AGENT_NOT_FOUND", "Agent not found.", 404);
}
