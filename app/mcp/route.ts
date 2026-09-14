import { appOrigin } from "@/lib/auth";
import {
  AuthError,
  authErrorResponse,
  getPrincipal,
  requireScope,
} from "@/lib/auth-principal";
import { createBrainHandler, requiredMcpScope } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    // Native/cloud MCP clients omit Origin; browser clients require an explicit allowlist.
    const allowed = [
      appOrigin(),
      ...(process.env.MCP_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ];
    if (origin && !allowed.includes(origin))
      throw new AuthError("invalid_origin", "This origin is not allowed.", 403);
    if (!request.headers.has("authorization"))
      throw new AuthError(
        "unauthorized",
        "Connect an agent using OAuth or an agent token.",
        401,
        {
          "WWW-Authenticate": `Bearer resource_metadata="${appOrigin()}/.well-known/oauth-protected-resource/mcp", scope="brain:read brain:write"`,
        },
      );
    const principal = await getPrincipal(request);
    if (
      !principal.scopes.some((scope) =>
        ["brain:read", "brain:write", "brain:maintain"].includes(scope),
      )
    )
      throw new AuthError(
        "insufficient_scope",
        "A brain scope is required.",
        403,
        {
          "WWW-Authenticate":
            'Bearer error="insufficient_scope", scope="brain:read"',
        },
      );
    const reader = request.body?.getReader();
    if (!reader)
      return Response.json(
        { error: "A JSON-RPC request is required." },
        { status: 400 },
      );
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 1_500_000) {
        await reader.cancel();
        return Response.json(
          { error: "Request exceeds 1.5 MB." },
          { status: 413 },
        );
      }
      parts.push(value);
    }
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(Buffer.concat(parts).toString("utf8"));
    } catch {
      return Response.json({ error: "Invalid JSON." }, { status: 400 });
    }
    const scope = requiredMcpScope(parsedBody);
    if (scope) requireScope(principal, scope);
    const handler = createBrainHandler(principal);
    const response = await handler.fetch(request, { parsedBody });
    response.headers.set("Cache-Control", "no-store");
    if (origin) {
      response.headers.set("Access-Control-Allow-Origin", origin);
      response.headers.set("Vary", "Origin");
      response.headers.set(
        "Access-Control-Expose-Headers",
        "WWW-Authenticate, MCP-Protocol-Version",
      );
    }
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}

export function OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  const allowed = [
    appOrigin(),
    ...(process.env.MCP_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ];
  if (!origin || !allowed.includes(origin))
    return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Method, MCP-Name, DPoP",
      "Access-Control-Max-Age": "600",
    },
  });
}
