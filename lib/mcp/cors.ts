import { appOrigin } from "@/lib/auth";
import { authErrorResponse } from "@/lib/auth-principal";

const exposedHeaders =
  "WWW-Authenticate, MCP-Protocol-Version, DPoP-Nonce, Retry-After";

export const mcpRequestHeaders = [
  "Authorization",
  "Content-Type",
  "Accept",
  "MCP-Protocol-Version",
  "MCP-Method",
  "MCP-Name",
  "DPoP",
];
export const oauthRequestHeaders = [
  "Authorization",
  "Content-Type",
  "Accept",
  "DPoP",
];

// These protocol endpoints use OAuth credentials or public metadata, not the
// browser login session. Authorize, consent, and account routes stay same-origin.
const oauthMethods: Record<string, readonly string[]> = {
  "/api/auth/oauth2/token": ["POST"],
  "/api/auth/oauth2/register": ["POST"],
  "/api/auth/oauth2/revoke": ["POST"],
  "/api/auth/oauth2/userinfo": ["GET", "POST"],
  "/api/auth/jwks": ["GET"],
};

export function oauthCorsMethods(request: Request) {
  return oauthMethods[new URL(request.url).pathname];
}

function allowedOrigin(origin: string) {
  return [
    appOrigin(),
    ...(process.env.MCP_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ].includes(origin);
}

function corsResponse(response: Response, origin: string | null) {
  const headers = new Headers(response.headers);
  const vary = headers.get("Vary");
  if (
    !vary?.split(",").some((value) => value.trim().toLowerCase() === "origin")
  )
    headers.set("Vary", vary ? `${vary}, Origin` : "Origin");
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Expose-Headers", exposedHeaders);
  }
  // No Allow-Credentials: adding an agent origin never grants cookie access.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function deniedOrigin() {
  return corsResponse(
    Response.json(
      { error: "This origin is not allowed.", code: "invalid_origin" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    ),
    null,
  );
}

export async function withAgentCors(
  request: Request,
  handler: () => Response | Promise<Response>,
) {
  const origin = request.headers.get("origin");
  let responseOrigin: string | null = null;
  let response: Response;
  try {
    if (origin && !allowedOrigin(origin)) return deniedOrigin();
    responseOrigin = origin;
    response = await handler();
  } catch (error) {
    response = authErrorResponse(error);
  }
  // Apply headers after handling so 401/403 challenges and early errors are
  // readable by an allowed browser client, just like successful MCP responses.
  return corsResponse(response, responseOrigin);
}

export function agentCorsPreflight(
  request: Request,
  methods: readonly string[],
  requestHeaders: readonly string[],
) {
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigin(origin)) return deniedOrigin();
  const method = request.headers.get("Access-Control-Request-Method");
  const headers = request.headers.get("Access-Control-Request-Headers");
  const supportedHeaders = requestHeaders.map((header) => header.toLowerCase());
  if (
    (method && !methods.includes(method.toUpperCase())) ||
    headers
      ?.split(",")
      .some((header) => !supportedHeaders.includes(header.trim().toLowerCase()))
  )
    return corsResponse(new Response(null, { status: 403 }), origin);
  return corsResponse(
    new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": [...methods, "OPTIONS"].join(", "),
        "Access-Control-Allow-Headers": requestHeaders.join(", "),
        "Access-Control-Max-Age": "600",
      },
    }),
    origin,
  );
}
