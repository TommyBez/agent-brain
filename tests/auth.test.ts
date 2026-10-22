import assert from "node:assert/strict";
import test from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { allowedEmails, isAllowedEmail, mcpResource } from "../lib/auth";
import {
  AuthError,
  assertSameOrigin,
  newAgentToken,
  requireScope,
  tokenHash,
} from "../lib/auth-principal";
import {
  BRAIN_INSTRUCTIONS,
  BRAIN_INSTRUCTIONS_PRE_TASKS,
  brainInstructions,
  createBrainHandler,
  mcpToolInvalidation,
  requiredMcpScope,
} from "../lib/mcp/server";
import { TASK_PROCEDURES } from "../lib/tasks/tool-definitions";

const TASK_TOOL_NAMES = [
  "list_tasks",
  "read_task",
  "create_task",
  "update_task",
  "claim_task",
  "report_task",
  "release_task",
  "complete_task",
];

// The owner's task manager setting lives in the database; these tests inject
// it per request instead, as createBrainHandler allows.
const tasksSetting = (enabled: boolean) => async () => enabled;

async function connectTo(
  handler: ReturnType<typeof createBrainHandler>,
  name: string,
) {
  const client = new Client(
    { name, version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://brain.example/mcp"), {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    }),
  );
  return client;
}

test("BRAIN_OWNER_EMAIL is a case-insensitive allowlist of separate accounts", () => {
  const previous = process.env.BRAIN_OWNER_EMAIL;
  try {
    process.env.BRAIN_OWNER_EMAIL =
      " Owner@Example.com, other@example.com, owner@example.com, ";
    assert.deepEqual(allowedEmails(), [
      "owner@example.com",
      "other@example.com",
    ]);
    assert.equal(isAllowedEmail("OTHER@example.com"), true);
    assert.equal(isAllowedEmail("stranger@example.com"), false);
  } finally {
    if (previous === undefined) delete process.env.BRAIN_OWNER_EMAIL;
    else process.env.BRAIN_OWNER_EMAIL = previous;
  }
});

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
  const handler = createBrainHandler(
    {
      ownerId: "test-owner",
      kind: "token",
      scopes: ["brain:write"],
    },
    undefined,
    tasksSetting(false),
  );
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
  // With the task manager on, so every tool the server can register is here.
  const handler = createBrainHandler(
    principal,
    () => {
      mutations++;
    },
    tasksSetting(true),
  );
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
    list_tasks: {},
    read_task: { ref: "T-1" },
    create_task: {
      title: "Private task",
      origin: "owner_request",
      ownerQuote: "Track this",
      idempotencyKey: "scope-check-1",
    },
    update_task: {
      ref: "T-1",
      expectedVersion: 1,
      patch: { title: "Private" },
    },
    claim_task: { next: {} },
    report_task: {
      ref: "T-1",
      leaseId: "6f1c1a4e-2b3d-4e5f-8a9b-0c1d2e3f4a5b",
      note: "Private progress",
    },
    release_task: {
      ref: "T-1",
      leaseId: "6f1c1a4e-2b3d-4e5f-8a9b-0c1d2e3f4a5b",
      reason: "handoff",
      note: "Private handoff",
    },
    complete_task: {
      ref: "T-1",
      leaseId: "6f1c1a4e-2b3d-4e5f-8a9b-0c1d2e3f4a5b",
      summary: "Private summary",
    },
  };
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("https://brain.example/mcp"), {
        fetch: (input, init) => handler.fetch(new Request(input, init)),
      }),
    );
    const { tools } = await client.listTools();
    assert.equal(tools.length, 19);
    for (const name of TASK_TOOL_NAMES)
      assert.ok(
        tools.some((tool) => tool.name === name),
        `${name} is registered`,
      );
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

test("task tools use the existing scopes and expire only the tasks cache", () => {
  for (const name of TASK_TOOL_NAMES) {
    const scope = requiredMcpScope({
      method: "tools/call",
      params: { name },
    });
    assert.equal(
      scope,
      name === "list_tasks" || name === "read_task"
        ? "brain:read"
        : "brain:write",
      name,
    );
    assert.equal(
      mcpToolInvalidation(name),
      scope === "brain:read" ? "none" : "tasks",
      name,
    );
  }
  for (const name of ["write", "append", "index_chunks"])
    assert.equal(mcpToolInvalidation(name), "workspace", name);
  for (const name of [
    "search",
    "read",
    "resolve",
    "related",
    "context",
    "pending_embeddings",
    "gap_analysis",
    "list_pages",
  ])
    assert.equal(mcpToolInvalidation(name), "none", name);
});

test("task tools and their protocol resource stay hidden while the owner's task manager is off", async () => {
  const principal = {
    ownerId: "test-owner",
    kind: "token" as const,
    scopes: ["brain:read"],
  };
  for (const enabled of [false, true]) {
    const handler = createBrainHandler(
      principal,
      undefined,
      tasksSetting(enabled),
    );
    const client = await connectTo(handler, "task-setting");
    try {
      const { tools } = await client.listTools();
      const { resources } = await client.listResources();
      assert.equal(
        tools.filter((tool) => TASK_TOOL_NAMES.includes(tool.name)).length,
        enabled ? 8 : 0,
      );
      assert.equal(
        resources.some(
          (resource) => resource.uri === "brain://procedures/tasks",
        ),
        enabled,
      );
      if (enabled) {
        const procedures = await client.readResource({
          uri: "brain://procedures/tasks",
        });
        const [content] = procedures.contents;
        assert.equal("text" in content ? content.text : "", TASK_PROCEDURES);
      }
      assert.equal((await client.listPrompts()).prompts.length, 3);
      // Instructions, prompts and brain://procedures never point at task
      // tools the server does not register.
      const instructions = enabled
        ? BRAIN_INSTRUCTIONS
        : BRAIN_INSTRUCTIONS_PRE_TASKS;
      assert.equal(client.getInstructions(), instructions);
      const [procedure] = (
        await client.readResource({ uri: "brain://procedures" })
      ).contents;
      assert.equal("text" in procedure ? procedure.text : "", instructions);
      const [message] = (
        await client.getPrompt({ name: "before_work", arguments: {} })
      ).messages;
      assert.ok(
        message.content.type === "text" &&
          message.content.text.startsWith(`${instructions}\n\nProcedure:`),
      );
      if (!enabled)
        assert.doesNotMatch(
          instructions,
          /Brain tasks|report_task|brain:\/\/procedures\/tasks|task keeper|closes a task/,
        );
    } finally {
      await client.close();
    }
  }
});

test("brainInstructions follows the switch it is given, with no default", () => {
  assert.equal(brainInstructions(true), BRAIN_INSTRUCTIONS);
  assert.equal(brainInstructions(false), BRAIN_INSTRUCTIONS_PRE_TASKS);
});

test("the task manager setting is read for the principal's owner on every MCP request", async () => {
  const principal = {
    ownerId: "owner-a",
    kind: "token" as const,
    scopes: ["brain:read"],
  };
  const asked: string[] = [];
  let enabled = false;
  const handler = createBrainHandler(principal, undefined, async (ownerId) => {
    asked.push(ownerId);
    return enabled;
  });
  const client = await connectTo(handler, "task-setting-per-request");
  const taskTools = async () =>
    (await client.listTools()).tools.filter((tool) =>
      TASK_TOOL_NAMES.includes(tool.name),
    ).length;
  const procedures = async () => {
    const [content] = (await client.readResource({ uri: "brain://procedures" }))
      .contents;
    return "text" in content ? content.text : "";
  };
  try {
    assert.equal(await taskTools(), 0);
    assert.equal(await procedures(), BRAIN_INSTRUCTIONS_PRE_TASKS);
    // The owner turns the task manager on: the same connection sees the task
    // tools and the full instructions on its next request, then loses them
    // again when it is turned off.
    enabled = true;
    assert.equal(await taskTools(), 8);
    assert.equal(await procedures(), BRAIN_INSTRUCTIONS);
    enabled = false;
    assert.equal(await taskTools(), 0);
    assert.equal(await procedures(), BRAIN_INSTRUCTIONS_PRE_TASKS);
    assert.ok(asked.length >= 6, `one read per request: ${asked.length}`);
    assert.ok(asked.every((ownerId) => ownerId === "owner-a"));
  } finally {
    await client.close();
  }
});

test("an unreadable task manager setting fails the MCP request instead of guessing", async () => {
  let reads = 0;
  const handler = createBrainHandler(
    { ownerId: "owner-a", kind: "token", scopes: ["brain:read"] },
    undefined,
    async () => {
      reads++;
      throw new Error("database unavailable");
    },
  );
  await assert.rejects(
    connectTo(handler, "task-setting-unreadable"),
    /HTTP 500/,
  );
  assert.ok(reads > 0);
});

test("registered MCP prompts enforce the same scope as the route pre-check", async () => {
  const principal = {
    ownerId: "test-owner",
    kind: "token" as const,
    scopes: ["brain:read"],
  };
  const handler = createBrainHandler(principal, undefined, tasksSetting(false));
  const client = await connectTo(handler, "prompt-scope-consistency");
  try {
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
