import { getAuth, isAuthConfigured } from "@/lib/auth";
import {
  agentCorsPreflight,
  oauthCorsMethods,
  oauthRequestHeaders,
  withAgentCors,
} from "@/lib/mcp/cors";

export const runtime = "nodejs";

async function handleAuth(request: Request) {
  if (!isAuthConfigured())
    return Response.json(
      { error: "Authentication has not been configured." },
      { status: 503 },
    );
  return getAuth().handler(request);
}

function handler(request: Request) {
  // Preserve the request's Origin and Cookie headers. Better Auth still owns
  // all client authentication, grant validation, and session/CSRF checks.
  return oauthCorsMethods(request)
    ? withAgentCors(request, () => handleAuth(request))
    : handleAuth(request);
}

export function OPTIONS(request: Request) {
  const methods = oauthCorsMethods(request);
  if (!methods)
    return new Response(null, {
      status: 405,
      headers: { Allow: "GET, POST" },
    });
  return agentCorsPreflight(request, methods, oauthRequestHeaders);
}

export { handler as GET, handler as POST };
