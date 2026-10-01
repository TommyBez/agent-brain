import assert from "node:assert/strict";
import test from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { mcpResource } from "../lib/auth";
import {
  AuthError,
  assertSameOrigin,
  newAgentToken,
  requireScope,
  tokenHash,
} from "../lib/auth-principal";
import { createBrainHandler, requiredMcpScope } from "../lib/mcp/server";

test("headless credentials contain 256 random bits and only their hash is used for storage", () => {
  const first = newAgentToken();
  const second = newAgentToken();
  assert.match(first, /^brain_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.equal(tokenHash(first).length, 64);
  assert.notEqual(tokenHash(first), first);
});

test("read permission cannot authorize a write or maintenance action", () => {
  const principal = {
    ownerId: "owner",
    kind: "token" as const,
    scopes: ["brain:read"],
  };
  requireScope(principal, "brain:read");
  assert.throws(
    () => requireScope(principal, "brain:write"),
    (error: unknown) => error instanceof AuthError && error.status === 403,
  );
  assert.throws(() => requireScope(principal, "brain:maintain"), AuthError);
});

test("cookie mutation origin is checked against configuration, not an attacker-controlled URL", () => {
  const previous = process.env.BETTER_AUTH_URL;
  process.env.BETTER_AUTH_URL = "https://brain.example.com";
  try {
    assertSameOrigin(
      new Request("https://brain.example.com/api/operations", {
        headers: { origin: "https://brain.example.com" },
      }),
    );
    assert.throws(
      () =>
        assertSameOrigin(
          new Request("https://evil.example/api/operations", {
            headers: { origin: "https://evil.example" },
          }),
        ),
      AuthError,
    );
    assert.throws(
      () =>
        assertSameOrigin(
          new Request("https://brain.example.com/api/operations"),
        ),
      AuthError,
    );
  } finally {
    if (previous) process.env.BETTER_AUTH_URL = previous;
    else delete process.env.BETTER_AUTH_URL;
  }
});

test("production browser mutations and MCP use the Vercel project domain", () => {
  const selectedEnv = {
    VERCEL_ENV: "production",
    VERCEL_PROJECT_PRODUCTION_URL: "agent-brain.vercel.app",
    VERCEL_URL: "agent-brain-deployment.vercel.app",
    BETTER_AUTH_URL: "https://agent-brain-old.vercel.app",
  };
  const previous = Object.fromEntries(
    Object.keys(selectedEnv).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, selectedEnv);
  try {
    assertSameOrigin(
      new Request("https://agent-brain.vercel.app/api/brain/pages", {
        headers: { origin: "https://agent-brain.vercel.app" },
      }),
    );
    assert.equal(mcpResource(), "https://agent-brain.vercel.app/mcp");
    for (const origin of [
      "https://agent-brain-old.vercel.app",
      "https://agent-brain-deployment.vercel.app",
      "https://evil.example",
      undefined,
    ]) {
      assert.throws(
        () =>
          assertSameOrigin(
            new Request("https://agent-brain.vercel.app/api/brain/pages", {
              headers: origin ? { origin } : {},
            }),
          ),
        AuthError,
      );
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("MCP search and context enforce read scope before contacting an embedding provider", async (t) => {
  const originalKey = process.env.BRAIN_EMBEDDING_API_KEY;
  const originalEnabled = process.env.BRAIN_QUERY_EMBEDDINGS;
  process.env.BRAIN_EMBEDDING_API_KEY = "test-embedding-key";
  process.env.BRAIN_QUERY_EMBEDDINGS = "true";
  const provider = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("An unauthorized tool must not contact a provider");
  });
  const handler = createBrainHandler({
    ownerId: "test-owner",
    kind: "token",
    scopes: ["brain:write"],
  });
  const client = new Client(
    { name: "scope-regression-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("https://brain.example/mcp"), {
        fetch: (input, init) => handler.fetch(new Request(input, init)),
      }),
    );
    for (const name of ["search", "context"]) {
      const response = await client.callTool({
        name,
        arguments: { query: "Private retrieval query" },
      });
      assert.equal(response.isError, true);
      assert.equal(
        (response.structuredContent as { error: { code: string } }).error.code,
        "insufficient_scope",
      );
    }
    assert.equal(provider.mock.callCount(), 0);
  } finally {
    await client.close();
    if (originalKey) process.env.BRAIN_EMBEDDING_API_KEY = originalKey;
    else delete process.env.BRAIN_EMBEDDING_API_KEY;
    if (originalEnabled) process.env.BRAIN_QUERY_EMBEDDINGS = originalEnabled;
    else delete process.env.BRAIN_QUERY_EMBEDDINGS;
  }
});

test("every registered MCP tool agrees with the route scope check and rejects a missing scope", async () => {
  let mutations = 0;
  const principal = {
    ownerId: "test-owner",
    kind: "token" as const,
    scopes: [],
  };
  const handler = createBrainHandler(principal, () => {
    mutations++;
  });
  const client = new Client(
    { name: "tool-scope-consistency", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const argumentsByTool: Record<string, Record<string, unknown>> = {
    search: { query: "private query" },
    read: { ref: "private-page" },
    write: {
      expectedVersion: 0,
      title: "Private",
      type: "note",
      markdown: "Private body",
    },
    append: {
      ref: "private-page",
      expectedVersion: 1,
      markdown: "Private body",
    },
    resolve: { name: "Private" },
    related: { ref: "private-page" },
    context: { query: "private query" },
    index_chunks: {
      ref: "private-page",
      expectedVersion: 1,
      embeddingModel: "model",
      chunkerVersion: "version",
      embeddings: [],
    },
    pending_embeddings: {},
    gap_analysis: {},
    list_pages: {},
  };
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("https://brain.example/mcp"), {
        fetch: (input, init) => handler.fetch(new Request(input, init)),
      }),
    );
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0);
    for (const tool of tools) {
      const scope = requiredMcpScope({
        method: "tools/call",
        params: { name: tool.name },
      });
      assert.ok(scope, `${tool.name} must have a route-level scope`);
      assert.throws(() => requireScope(principal, scope), AuthError);
      assert.ok(
        argumentsByTool[tool.name],
        `Add valid arguments for ${tool.name}`,
      );
      const response = await client.callTool({
        name: tool.name,
        arguments: argumentsByTool[tool.name],
      });
      assert.equal(response.isError, true, tool.name);
      assert.equal(
        (response.structuredContent as { error: { code: string } }).error.code,
        "insufficient_scope",
        tool.name,
      );
    }
    assert.equal(mutations, 0);
  } finally {
    await client.close();
  }
});

test("registered MCP prompts enforce the same scope as the route pre-check", async () => {
  const principal = {
    ownerId: "test-owner",
    kind: "token" as const,
    scopes: ["brain:read"],
  };
  const handler = createBrainHandler(principal);
  const client = new Client(
    { name: "prompt-scope-consistency", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("https://brain.example/mcp"), {
        fetch: (input, init) => handler.fetch(new Request(input, init)),
      }),
    );
    const { prompts } = await client.listPrompts();
    assert.equal(prompts.length, 3);
    for (const prompt of prompts) {
      const scope = requiredMcpScope({
        method: "prompts/get",
        params: { name: prompt.name },
      });
      assert.ok(scope, `${prompt.name} must have a route-level scope`);
      if (principal.scopes.includes(scope)) {
        const result = await client.getPrompt({
          name: prompt.name,
          arguments: {},
        });
        assert.ok(result.messages.length > 0);
      } else {
        assert.throws(() => requireScope(principal, scope), AuthError);
        await assert.rejects(
          client.getPrompt({ name: prompt.name, arguments: {} }),
          /requires brain:maintain/,
        );
      }
    }
    principal.scopes.push("brain:maintain");
    const result = await client.getPrompt({
      name: "nightly_consolidation",
      arguments: {},
    });
    assert.ok(result.messages.length > 0);
    assert.equal(
      requiredMcpScope({ method: "prompts/get", params: { name: "unknown" } }),
      undefined,
    );
  } finally {
    await client.close();
  }
});
