import { createHash, randomBytes } from "node:crypto";
import { requireMcpAuth } from "@better-auth/mcp";
import {
  allowedEmails,
  appOrigin,
  BRAIN_SCOPES,
  type BrainScope,
  getAuth,
  getSession,
  isAuthConfigured,
  mcpResource,
  READ_WRITE_SCOPES,
} from "@/lib/auth";
import { getPool } from "@/lib/db";

export type Principal = {
  ownerId: string;
  scopes: string[];
  kind: "session" | "token" | "oauth";
  tokenId?: string;
  /** OAuth only: the access token's client_id (azp as fallback). */
  clientId?: string;
};

export class AuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 401,
    public headers?: HeadersInit,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export function requireScope(principal: Principal, scope: BrainScope) {
  if (!principal.scopes.includes(scope))
    throw new AuthError(
      "insufficient_scope",
      `This operation requires ${scope}.`,
      403,
      {
        "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${scope}"`,
      },
    );
}

export function assertSameOrigin(request: Request) {
  // Cookie-authorized mutations must come from our actual site, not a reflected request URL.
  if (request.headers.get("origin") !== appOrigin())
    throw new AuthError(
      "invalid_origin",
      "This operation must originate from a native brain.",
      403,
    );
}

export function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export function newAgentToken() {
  return `brain_${randomBytes(32).toString("base64url")}`;
}

function agentDisabled() {
  return new AuthError(
    "agent_disabled",
    "The owner has disabled this agent in Agent Brain.",
    403,
  );
}

export async function principalFromAgentToken(
  token: string,
): Promise<Principal> {
  if (!/^brain_[A-Za-z0-9_-]{43}$/.test(token))
    throw new AuthError("invalid_token", "Invalid agent token.");
  // One round trip: validity, owner allowlist and a disabled agent, with
  // last_used_at written at most every 5 minutes.
  const { rows } = await getPool().query<{
    id: string;
    owner_id: string;
    scopes: string[];
    disabled: boolean;
  }>(
    `WITH t AS (
       SELECT t.id, t.owner_id, t.scopes, a.disabled_at IS NOT NULL AS disabled
       FROM agent_tokens AS t JOIN "user" AS u ON u.id = t.owner_id
       LEFT JOIN brain_agents AS a ON a.owner_id = t.owner_id AND a.id = t.agent_id
       WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > now()
         AND lower(u.email) = ANY($2::text[])
     ), touched AS (
       UPDATE agent_tokens SET last_used_at = now()
       WHERE id = (SELECT id FROM t WHERE NOT disabled)
         AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')
     )
     SELECT id, owner_id, scopes, disabled FROM t`,
    [tokenHash(token), allowedEmails()],
  );
  if (!rows[0])
    throw new AuthError(
      "invalid_token",
      "The agent token is invalid, expired, or revoked.",
    );
  if (rows[0].disabled) throw agentDisabled();
  return {
    ownerId: rows[0].owner_id,
    scopes: rows[0].scopes,
    kind: "token",
    tokenId: rows[0].id,
  };
}

/** OAuth subject must be an allowlisted owner; a disabled client agent is refused. */
export async function assertOAuthPrincipal(
  subject: string,
  clientId: string | undefined,
) {
  const { rows } = await getPool().query<{ disabled: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM brain_agent_clients AS c
       JOIN brain_agents AS a ON a.owner_id = c.owner_id AND a.id = c.agent_id
       WHERE c.owner_id = u.id AND c.client_id = $3 AND a.disabled_at IS NOT NULL
     ) AS disabled
     FROM "user" AS u WHERE u.id = $1 AND lower(u.email) = ANY($2::text[])`,
    [subject, allowedEmails(), clientId ?? null],
  );
  if (!rows.length)
    throw new AuthError(
      "forbidden",
      "This identity does not own this brain.",
      403,
    );
  if (rows[0].disabled) throw agentDisabled();
}

function claimString(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

export async function getPrincipal(request: Request): Promise<Principal> {
  if (!isAuthConfigured())
    throw new AuthError(
      "not_configured",
      "Authentication has not been configured.",
      503,
    );
  const authorization = request.headers.get("authorization");
  // An invalid Authorization header must never fall back to a browser session.
  if (authorization) {
    if (/^Bearer brain_/i.test(authorization))
      return principalFromAgentToken(authorization.slice(7));
    let principal: Principal | undefined;
    const response = await requireMcpAuth(
      getAuth(),
      async (_request, claims) => {
        if (typeof claims.sub !== "string")
          throw new AuthError(
            "invalid_subject",
            "A user-bound access token is required.",
            403,
          );
        const clientId =
          claimString(claims.client_id) ?? claimString(claims.azp);
        await assertOAuthPrincipal(claims.sub, clientId);
        principal = {
          ownerId: claims.sub,
          scopes:
            typeof claims.scope === "string" ? claims.scope.split(/\s+/) : [],
          kind: "oauth",
          ...(clientId ? { clientId } : {}),
        };
        return new Response(null, { status: 204 });
      },
      {
        resource: mcpResource(),
        challengeScopes: READ_WRITE_SCOPES.split(" "),
      },
    )(request);
    if (!principal)
      throw new AuthError(
        "invalid_token",
        "An authorized access token is required.",
        response.status,
        response.headers,
      );
    return principal;
  }
  const session = await getSession(request.headers);
  if (!session)
    throw new AuthError(
      "unauthorized",
      "Sign in or provide an agent token.",
      401,
      {
        "WWW-Authenticate": `Bearer resource_metadata="${appOrigin()}/.well-known/oauth-protected-resource/mcp", scope="${READ_WRITE_SCOPES}"`,
      },
    );
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method))
    assertSameOrigin(request);
  return {
    ownerId: session.user.id,
    scopes: [...BRAIN_SCOPES],
    kind: "session",
  };
}

export async function requireSessionPrincipal(request: Request) {
  if (request.headers.has("authorization"))
    throw new AuthError(
      "session_required",
      "Use a browser session to manage credentials.",
      403,
    );
  return getPrincipal(request);
}

export function authErrorResponse(error: unknown) {
  if (error instanceof AuthError)
    return Response.json(
      { error: error.message, code: error.code },
      {
        status: error.status,
        headers: {
          ...Object.fromEntries(new Headers(error.headers)),
          "Cache-Control": "no-store",
        },
      },
    );
  console.error(
    "Authentication operation failed",
    error instanceof Error ? error.name : "unknown error",
  );
  return Response.json(
    { error: "The authentication service is temporarily unavailable." },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
