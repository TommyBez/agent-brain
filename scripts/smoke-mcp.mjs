// Read-only production verification. Run with BRAIN_URL and BRAIN_AGENT_TOKEN.
import assert from "node:assert/strict";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const base = process.env.BRAIN_URL || process.env.BETTER_AUTH_URL;
const token = process.env.BRAIN_AGENT_TOKEN;
const knownRef = process.env.BRAIN_SMOKE_REF;

function data(result) {
  assert.ok(!result.isError, "MCP tool returned an error");
  if (result.structuredContent && "data" in result.structuredContent)
    return result.structuredContent.data;
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, "Expected a structured or text tool response");
  return JSON.parse(text);
}

async function document(url) {
  const browserOrigin = new URL(base).origin;
  const response = await fetch(url, {
    headers: { Origin: browserOrigin },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(
    response.status,
    200,
    `Discovery endpoint returned HTTP ${response.status}`,
  );
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    browserOrigin,
  );
  return response.json();
}

async function main() {
  assert.ok(base, "Set BRAIN_URL to the deployed application origin");
  assert.ok(token, "Set BRAIN_AGENT_TOKEN to a token with brain:read");
  const origin = new URL(base);
  assert.ok(
    origin.protocol === "https:" ||
      (origin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)),
    "Use public HTTPS or localhost",
  );
  assert.equal(
    origin.pathname,
    "/",
    "BRAIN_URL must be an origin without /mcp",
  );
  assert.ok(
    !origin.username && !origin.password && !origin.search && !origin.hash,
    "Use a plain application origin",
  );
  const endpoint = new URL("/mcp", origin);
  const unauthorized = await fetch(endpoint, {
    method: "POST",
    headers: {
      Origin: origin.origin,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(
    unauthorized.status,
    401,
    "Unauthenticated MCP must return HTTP 401",
  );
  assert.equal(
    unauthorized.headers.get("access-control-allow-origin"),
    origin.origin,
  );
  assert.match(
    unauthorized.headers.get("access-control-expose-headers") || "",
    /WWW-Authenticate/i,
  );
  const challenge = unauthorized.headers.get("www-authenticate") || "";
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  assert.ok(metadataUrl, "OAuth challenge must advertise resource metadata");
  assert.equal(
    new URL(metadataUrl).origin,
    origin.origin,
    "Metadata must belong to this brain",
  );
  const resource = await document(metadataUrl);
  assert.equal(resource.resource, endpoint.href);
  assert.ok(resource.scopes_supported.includes("brain:read"));
  const issuer = new URL(resource.authorization_servers[0]);
  assert.equal(
    issuer.origin,
    origin.origin,
    "Authorization issuer must belong to this brain",
  );
  const metadata = await document(
    new URL(
      `/.well-known/oauth-authorization-server${issuer.pathname === "/" ? "" : issuer.pathname}`,
      issuer,
    ),
  );
  assert.equal(metadata.issuer, issuer.href.replace(/\/$/, ""));
  assert.equal(metadata.client_id_metadata_document_supported, true);
  assert.ok(metadata.code_challenge_methods_supported.includes("S256"));
  assert.ok(metadata.token_endpoint_auth_methods_supported.includes("none"));
  for (const url of [
    endpoint.href,
    metadata.token_endpoint,
    metadata.registration_endpoint,
  ]) {
    assert.equal(new URL(url).origin, origin.origin);
    const preflight = await fetch(url, {
      method: "OPTIONS",
      headers: {
        Origin: origin.origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      origin.origin,
    );
  }
  console.log(
    "PASS public OAuth discovery, CIMD, PKCE, browser CORS and unauthenticated challenge",
  );

  const client = new Client(
    { name: "agent-brain-production-smoke", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
      { timeout: 30_000 },
    );
    const tools = await client.listTools({}, { timeout: 30_000 });
    for (const name of [
      "search",
      "read",
      "write",
      "append",
      "resolve",
      "related",
      "context",
    ])
      assert.ok(
        tools.tools.some((tool) => tool.name === name),
        `Missing primitive: ${name}`,
      );
    const prompts = await client.listPrompts({}, { timeout: 30_000 });
    for (const name of [
      "before_work",
      "after_conversation",
      "nightly_consolidation",
    ])
      assert.ok(
        prompts.prompts.some((prompt) => prompt.name === name),
        `Missing procedure: ${name}`,
      );
    const prompt = await client.getPrompt(
      {
        name: "before_work",
        arguments: { task: "Read-only production health check" },
      },
      { timeout: 30_000 },
    );
    assert.ok(prompt.messages.length > 0);
    const listed = data(
      await client.callTool(
        { name: "list_pages", arguments: { limit: 1 } },
        { timeout: 30_000 },
      ),
    );
    assert.ok(Array.isArray(listed.pages));
    const ref = knownRef || listed.pages[0]?.id;
    if (ref) {
      const page = data(
        await client.callTool(
          { name: "read", arguments: { ref } },
          { timeout: 30_000 },
        ),
      );
      assert.ok(
        typeof page.markdown === "string" && page.version >= 1,
        "Read must return markdown and current version",
      );
      data(
        await client.callTool(
          { name: "related", arguments: { ref, depth: 1, limit: 3 } },
          { timeout: 30_000 },
        ),
      );
      console.log("PASS read and graph retrieval with current page version");
    } else
      console.log(
        "PASS empty database can list pages; full-page read skipped (no pages)",
      );
    data(
      await client.callTool(
        {
          name: "resolve",
          arguments: { name: "__agent_brain_smoke_missing_entity__", limit: 1 },
        },
        { timeout: 30_000 },
      ),
    );
    data(
      await client.callTool(
        {
          name: "context",
          arguments: {
            query: "__agent_brain_smoke_healthcheck__",
            limit: 1,
            maxCharacters: 1000,
          },
        },
        { timeout: 30_000 },
      ),
    );
    console.log(
      `PASS authenticated MCP 2026-07-28: ${tools.tools.length} tools, ${prompts.prompts.length} procedures, read-only retrieval`,
    );
  } finally {
    await client.close();
  }
  const legacy = new Client({
    name: "agent-brain-legacy-smoke",
    version: "1.0.0",
  });
  try {
    await legacy.connect(
      new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
      { timeout: 30_000 },
    );
    assert.ok((await legacy.listTools()).tools.length >= 7);
    console.log("PASS legacy stateless Streamable HTTP compatibility");
  } finally {
    await legacy.close();
  }
}

main().catch((error) => {
  console.error(
    "MCP smoke failed:",
    error instanceof Error ? error.message : "Unknown error",
  );
  process.exitCode = 1;
});
