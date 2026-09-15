import { z } from "zod";
import { BRAIN_SCOPES } from "@/lib/auth";
import { AuthError, newAgentToken, tokenHash } from "@/lib/auth-principal";
import { assertOwner } from "@/lib/brain/utils";
import { getPool, transaction } from "@/lib/db";

export type AgentToken = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
};

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z
      .array(z.enum(BRAIN_SCOPES))
      .min(1)
      .max(3)
      .transform((scopes) => [...new Set(scopes)]),
    expiresInDays: z.number().int().min(1).max(365).default(90),
  })
  .strict();
const fields = `id, name, prefix, scopes, created_at AS "createdAt", expires_at AS "expiresAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"`;

// Credential metadata stays uncached. Callers must authenticate the owner first.
export async function listAgentTokens(ownerId: string): Promise<AgentToken[]> {
  assertOwner(ownerId);
  const { rows } = await getPool().query<AgentToken>(
    `SELECT ${fields} FROM agent_tokens WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [ownerId],
  );
  return rows;
}

export async function createAgentToken(ownerId: string, value: unknown) {
  assertOwner(ownerId);
  const parsed = createSchema.safeParse(value);
  if (!parsed.success)
    throw new AuthError(
      "invalid_input",
      "Provide a name, valid scopes, and expiry of 1–365 days.",
      400,
    );
  const input = parsed.data;
  const token = newAgentToken();
  const record = await transaction(async (client) => {
    await client.query(`SELECT id FROM "user" WHERE id = $1 FOR UPDATE`, [
      ownerId,
    ]);
    const existing = await client.query(
      `SELECT count(*)::int AS count FROM agent_tokens WHERE owner_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [ownerId],
    );
    if (existing.rows[0].count >= 50)
      throw new AuthError(
        "token_limit",
        "Revoke an existing token before creating another.",
        409,
      );
    const { rows } = await client.query<AgentToken>(
      `INSERT INTO agent_tokens (owner_id,name,prefix,token_hash,scopes,expires_at) VALUES ($1,$2,$3,$4,$5,now() + $6 * interval '1 day') RETURNING ${fields}`,
      [
        ownerId,
        input.name,
        token.slice(0, 14),
        tokenHash(token),
        input.scopes,
        input.expiresInDays,
      ],
    );
    return rows[0];
  });
  return { token, record };
}

export async function revokeAgentToken(ownerId: string, value: unknown) {
  assertOwner(ownerId);
  const parsed = z.object({ id: z.uuid() }).safeParse(value);
  if (!parsed.success)
    throw new AuthError("invalid_input", "A valid token id is required.", 400);
  const result = await getPool().query(
    `UPDATE agent_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1 AND owner_id = $2 RETURNING id`,
    [parsed.data.id, ownerId],
  );
  if (!result.rowCount)
    throw new AuthError("not_found", "Token not found.", 404);
  return { revoked: true };
}
