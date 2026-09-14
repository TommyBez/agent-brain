import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins/jwt";
import {
  GET as discoveryGET,
  OPTIONS as discoveryOPTIONS,
} from "../app/.well-known/[...path]/route";
import {
  OPTIONS as authOPTIONS,
  POST as authPOST,
} from "../app/api/auth/[...all]/route";
import { OPTIONS as mcpOPTIONS, POST as mcpPOST } from "../app/mcp/route";
import { AuthError } from "../lib/auth-principal";
import { withAgentCors } from "../lib/mcp/cors";

const app = "https://brain.example";
const browser = "https://agent-client.example";
const originalOrigin = process.env.BETTER_AUTH_URL;
const originalAllowed = process.env.MCP_ALLOWED_ORIGINS;

before(() => {
  process.env.BETTER_AUTH_URL = app;
  process.env.MCP_ALLOWED_ORIGINS = ` ${browser},https://another-agent.example `;
});
after(() => {
  if (originalOrigin) process.env.BETTER_AUTH_URL = originalOrigin;
  else delete process.env.BETTER_AUTH_URL;
  if (originalAllowed) process.env.MCP_ALLOWED_ORIGINS = originalAllowed;
  else delete process.env.MCP_ALLOWED_ORIGINS;
});

function assertCors(response: Response, origin = browser) {
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
  assert.match(response.headers.get("Vary") ?? "", /\bOrigin\b/);
  assert.match(
    response.headers.get("Access-Control-Expose-Headers") ?? "",
    /WWW-Authenticate/,
  );
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"), null);
}

function preflight(path: string, method: string, headers = "Authorization") {
  return new Request(`${app}${path}`, {
    method: "OPTIONS",
    headers: {
      origin: browser,
      "Access-Control-Request-Method": method,
      "Access-Control-Request-Headers": headers,
    },
  });
}

test("an allowed browser can read the real MCP OAuth challenge", async () => {
  const request = new Request(`${app}/mcp`, {
    method: "POST",
    headers: { origin: browser, "Content-Type": "application/json" },
    body: "{}",
  });
  const options = mcpOPTIONS(
    preflight("/mcp", "POST", "Content-Type, MCP-Protocol-Version"),
  );
  assert.equal(options.status, 204);
  assertCors(options);
  const response = await mcpPOST(request);
  assert.equal(response.status, 401);
  assertCors(response);
  assert.match(
    response.headers.get("WWW-Authenticate") ?? "",
    /resource_metadata="https:\/\/brain\.example\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
  assert.equal((await response.json()).code, "unauthorized");
});

test("MCP keeps the exact origin allowlist and supports clients without Origin", async () => {
  for (const origin of [app, browser, "https://another-agent.example"])
    assertCors(
      await mcpPOST(
        new Request(`${app}/mcp`, { method: "POST", headers: { origin } }),
      ),
      origin,
    );
  for (const origin of [
    "null",
    `${browser}.evil.example`,
    "https://unlisted.example",
  ])
    for (const method of ["POST", "OPTIONS"]) {
      const request = new Request(`${app}/mcp`, {
        method,
        headers: { origin },
      });
      const response =
        method === "POST" ? await mcpPOST(request) : mcpOPTIONS(request);
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
    }
  const native = await mcpPOST(new Request(`${app}/mcp`, { method: "POST" }));
  assert.equal(native.status, 401);
  assert.equal(native.headers.get("Access-Control-Allow-Origin"), null);
  assert.ok(native.headers.get("WWW-Authenticate"));
  assert.equal(mcpOPTIONS(preflight("/mcp", "DELETE")).status, 403);
  assert.equal(mcpOPTIONS(preflight("/mcp", "POST", "X-Unknown")).status, 403);
});

test("CORS preserves error challenges, response bodies, and existing cache variation", async () => {
  const request = new Request(`${app}/mcp`, { headers: { origin: browser } });
  for (const status of [200, 400, 401, 403, 413, 503]) {
    const response = await withAgentCors(request, () =>
      Response.json(
        { status },
        {
          status,
          headers: {
            Vary: "Accept",
            "WWW-Authenticate":
              'Bearer error="insufficient_scope", scope="brain:write"',
            "DPoP-Nonce": "test-nonce",
          },
        },
      ),
    );
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { status });
    assert.equal(response.headers.get("Vary"), "Accept, Origin");
    assert.equal(response.headers.get("DPoP-Nonce"), "test-nonce");
    assertCors(response);
  }
  const deniedScope = await withAgentCors(request, () => {
    throw new AuthError("insufficient_scope", "Read access required", 403, {
      "WWW-Authenticate":
        'Bearer error="insufficient_scope", scope="brain:read"',
    });
  });
  assert.equal(deniedScope.status, 403);
  assertCors(deniedScope);
  assert.match(deniedScope.headers.get("WWW-Authenticate") ?? "", /brain:read/);
});

test("discovery and OAuth routes expose protocol responses without opening cookie routes", async () => {
  const originalDatabase = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const response = await discoveryGET(
      new Request(`${app}/.well-known/oauth-protected-resource/mcp`, {
        headers: { origin: browser },
      }),
    );
    assert.equal(response.status, 503);
    assertCors(response);
    assert.equal(
      discoveryOPTIONS(
        preflight("/.well-known/oauth-protected-resource/mcp", "GET", "Accept"),
      ).status,
      204,
    );
    assert.equal(
      discoveryOPTIONS(
        preflight(
          "/.well-known/oauth-protected-resource/mcp",
          "POST",
          "Accept",
        ),
      ).status,
      403,
    );
    for (const [path, method] of [
      ["/oauth2/token", "POST"],
      ["/oauth2/register", "POST"],
      ["/oauth2/revoke", "POST"],
      ["/oauth2/userinfo", "GET"],
      ["/jwks", "GET"],
    ]) {
      const options = authOPTIONS(preflight(`/api/auth${path}`, method));
      assert.equal(options.status, 204);
      assertCors(options);
      assert.ok(
        options.headers
          .get("Access-Control-Allow-Headers")
          ?.includes("Authorization"),
      );
    }
    const token = await authPOST(
      new Request(`${app}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { origin: browser },
      }),
    );
    assert.equal(token.status, 503);
    assertCors(token);
    for (const path of [
      "/sign-in/email",
      "/oauth2/consent",
      "/change-password",
      "/get-session",
      "/oauth2/token/extra",
    ]) {
      const options = authOPTIONS(preflight(`/api/auth${path}`, "POST"));
      assert.equal(options.status, 405);
      assert.equal(options.headers.get("Access-Control-Allow-Origin"), null);
      const response = await authPOST(
        new Request(`${app}/api/auth${path}`, {
          method: "POST",
          headers: { origin: browser },
        }),
      );
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
    }
  } finally {
    if (originalDatabase) process.env.DATABASE_URL = originalDatabase;
  }
});

test("installed OAuth provider accepts cookie-free browser protocol calls and keeps CSRF checks", async () => {
  const provider = betterAuth({
    baseURL: app,
    secret: "cors-regression-only-secret-at-least-32-characters",
    trustedOrigins: [app],
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      jwks: [],
      oauthClient: [],
      oauthResource: [],
      oauthClientResource: [],
      oauthRefreshToken: [],
      oauthAccessToken: [],
      oauthConsent: [],
      oauthClientAssertion: [],
    }),
    rateLimit: { enabled: false },
    logger: { disabled: true },
    plugins: [
      jwt(),
      mcp({
        loginPage: "/sign-in",
        consentPage: "/consent",
        resource: `${app}/mcp`,
        scopes: ["brain:read", "offline_access"],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
    ],
  });
  const call = (request: Request) =>
    withAgentCors(request, () => provider.handler(request));
  const registrationRequest = (cookie?: string) =>
    new Request(`${app}/api/auth/oauth2/register`, {
      method: "POST",
      headers: {
        origin: browser,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "cors",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({
        client_name: "Browser CORS regression",
        redirect_uris: [`${browser}/callback`],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "brain:read offline_access",
      }),
    });
  const registration = await call(registrationRequest());
  assert.equal(registration.status, 201, await registration.clone().text());
  assertCors(registration);
  const { client_id: clientId } = await registration.json();
  assert.ok(clientId);
  const cookieRequest = await call(
    registrationRequest("better-auth.session_token=untrusted"),
  );
  assert.equal(cookieRequest.status, 403);
  assert.equal((await cookieRequest.json()).code, "INVALID_ORIGIN");
  assertCors(cookieRequest);

  const exchange = await call(
    new Request(`${app}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        origin: browser,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: "invalid-code",
        code_verifier: "invalid-verifier",
        redirect_uri: `${browser}/callback`,
      }),
    }),
  );
  assert.equal(exchange.status, 400);
  assert.equal((await exchange.json()).error, "invalid_grant");
  assertCors(exchange);
  for (const path of [
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server/api/auth",
    "/api/auth/jwks",
  ]) {
    const response = await call(
      new Request(`${app}${path}`, { headers: { origin: browser } }),
    );
    assert.equal(response.status, 200, await response.clone().text());
    assertCors(response);
  }
});
