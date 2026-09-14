import { appOrigin } from "@/lib/auth";
import {
  AuthError,
  authErrorResponse,
  getPrincipal,
  requireScope,
} from "@/lib/auth-principal";
import {
  agentCorsPreflight,
  mcpRequestHeaders,
  withAgentCors,
} from "@/lib/mcp/cors";
import { createBrainHandler, requiredMcpScope } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const maxDuration = 60;

async function handlePost(request: Request) {
  try {
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
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}

export function POST(request: Request) {
  return withAgentCors(request, () => handlePost(request));
}

export function OPTIONS(request: Request) {
  return agentCorsPreflight(request, ["POST"], mcpRequestHeaders);
}
