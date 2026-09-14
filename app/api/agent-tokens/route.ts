import { z } from "zod";
import { BRAIN_SCOPES } from "@/lib/auth";
import {
  AuthError,
  authErrorResponse,
  newAgentToken,
  requireSessionPrincipal,
  tokenHash,
} from "@/lib/auth-principal";
import { getPool, transaction } from "@/lib/db";

export const runtime = "nodejs";

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

export async function GET(request: Request) {
  try {
    const principal = await requireSessionPrincipal(request);
    const { rows } = await getPool().query(
      `SELECT ${fields} FROM agent_tokens WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [principal.ownerId],
    );
    return Response.json(
      { tokens: rows },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const principal = await requireSessionPrincipal(request);
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success)
      return Response.json(
        { error: "Provide a name, valid scopes, and expiry of 1–365 days." },
        { status: 400 },
      );
    const input = parsed.data;
    const token = newAgentToken();
    const record = await transaction(async (client) => {
      await client.query(`SELECT id FROM "user" WHERE id = $1 FOR UPDATE`, [
        principal.ownerId,
      ]);
      const existing = await client.query(
        `SELECT count(*)::int AS count FROM agent_tokens WHERE owner_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
        [principal.ownerId],
      );
      if (existing.rows[0].count >= 50)
        throw new AuthError(
          "token_limit",
          "Revoke an existing token before creating another.",
          409,
        );
      const { rows } = await client.query(
        `INSERT INTO agent_tokens (owner_id,name,prefix,token_hash,scopes,expires_at) VALUES ($1,$2,$3,$4,$5,now() + $6 * interval '1 day') RETURNING ${fields}`,
        [
          principal.ownerId,
          input.name,
          token.slice(0, 14),
          tokenHash(token),
          input.scopes,
          input.expiresInDays,
        ],
      );
      return rows[0];
    });
    return Response.json(
      { token, record },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof SyntaxError)
      return Response.json({ error: "Invalid JSON." }, { status: 400 });
    return authErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const principal = await requireSessionPrincipal(request);
    const parsed = z.object({ id: z.uuid() }).safeParse(await request.json());
    if (!parsed.success)
      return Response.json(
        { error: "A valid token id is required." },
        { status: 400 },
      );
    const result = await getPool().query(
      `UPDATE agent_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1 AND owner_id = $2 RETURNING id`,
      [parsed.data.id, principal.ownerId],
    );
    if (!result.rowCount)
      throw new AuthError("not_found", "Token not found.", 404);
    return Response.json(
      { revoked: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof SyntaxError)
      return Response.json({ error: "Invalid JSON." }, { status: 400 });
    return authErrorResponse(error);
  }
}
