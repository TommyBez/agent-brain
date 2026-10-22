import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  type McpHttpHandler,
  McpServer,
} from "@modelcontextprotocol/server";
import type { Principal } from "../lib/auth-principal";
import { getPool } from "../lib/db";
import { createBrainHandler } from "../lib/mcp/server";
import { ownerActor } from "../lib/tasks/actors";
import { setTasksEnabled } from "../lib/tasks/feature";
import { TASK_TOOL_DEFINITIONS } from "../lib/tasks/tool-definitions";
import type { CacheInvalidation } from "../lib/workspace/cache";

// Task tools validate in their services, so a schema-invalid call over MCP
// gets the documented INVALID_INPUT with issues and a remedy (§7.3), while
// tools/list keeps advertising the JSON Schema of each zod schema.

async function connect(handler: McpHttpHandler) {
  const client = new Client(
    { name: "mcp-task-invalid-input", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://brain.example/mcp"), {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    }),
  );
  return client;
}

test("task tools advertise the same tools/list entries as their zod schemas", async () => {
  // The reference registers the zod schemas directly, as before the
  // pass-through: tools/list must not change for any task tool.
  const reference = createMcpHandler(
    () => {
      const server = new McpServer({ name: "reference", version: "1.0.0" });
      for (const tool of TASK_TOOL_DEFINITIONS)
        server.registerTool(
          tool.name,
          {
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
          },
          () => ({ content: [] }),
        );
      return server;
    },
    { legacy: "stateless", keepAliveMs: 0, maxSubscriptions: 0 },
  );
  const expected = await connect(reference);
  // An owner with the task manager on, without a database.
  const actual = await connect(
    createBrainHandler(
      { ownerId: "test-owner", kind: "token", scopes: [] },
      undefined,
      async () => true,
    ),
  );
  try {
    const before = (await expected.listTools()).tools;
    const after = (await actual.listTools()).tools;
    assert.equal(before.length, TASK_TOOL_DEFINITIONS.length);
    for (const tool of before) {
      const served = after.find((entry) => entry.name === tool.name);
      assert.ok(served, `${tool.name} is registered`);
      assert.deepEqual(served.inputSchema, tool.inputSchema, tool.name);
      assert.deepEqual(served.description, tool.description, tool.name);
      assert.deepEqual(served.annotations, tool.annotations, tool.name);
      assert.ok(
        Object.keys(served.inputSchema.properties ?? {}).length > 0,
        `${tool.name} advertises its fields`,
      );
    }
  } finally {
    await expected.close();
    await actual.close();
  }
});

test(
  "schema-invalid task tool calls over MCP return INVALID_INPUT with a remedy",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 60_000 },
  async () => {
    const pool = getPool();
    const ownerId = randomUUID();
    const email = `mcp-invalid-input-${ownerId}@example.invalid`;
    const suffix = ownerId.slice(0, 8);
    const saved = {
      owner: process.env.BRAIN_OWNER_EMAIL,
      embeddings: process.env.BRAIN_QUERY_EMBEDDINGS,
    };
    process.env.BRAIN_OWNER_EMAIL = [saved.owner, email]
      .filter(Boolean)
      .join(",");
    process.env.BRAIN_QUERY_EMBEDDINGS = "false";
    await pool.query(
      `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Invalid Input Owner',$2,true,now(),now())`,
      [ownerId, email],
    );
    await setTasksEnabled(await ownerActor(ownerId), true);
    const principal: Principal = {
      ownerId,
      scopes: ["brain:read", "brain:write"],
      kind: "oauth",
      clientId: `invalid-input-${suffix}`,
    };
    const kinds: CacheInvalidation[] = [];
    const client = await connect(
      createBrainHandler(principal, (kind) => kinds.push(kind)),
    );
    try {
      const invalid = async (
        name: string,
        args: Record<string, unknown>,
        path: string,
      ) => {
        const response = await client.callTool({ name, arguments: args });
        assert.equal(response.isError, true, name);
        assert.ok(
          response.structuredContent,
          `${name}: ${JSON.stringify(response.content)}`,
        );
        const { error } = response.structuredContent as {
          error: {
            code: string;
            message: string;
            details: {
              issues: { path: string; message: string }[];
              remedy: string;
            };
          };
        };
        assert.equal(error.code, "INVALID_INPUT", name);
        assert.equal(error.message, "The task request is invalid.");
        assert.match(error.details.remedy, /Fix the listed fields and retry/);
        assert.ok(
          error.details.issues.some((issue) => issue.path === path),
          `${name}: ${JSON.stringify(error.details.issues)}`,
        );
        const [content] = response.content as { type: string; text: string }[];
        assert.deepEqual(JSON.parse(content.text), error);
      };

      await invalid("list_tasks", { limit: 80 }, "limit");
      await invalid(
        "create_task",
        {
          title: `Invalid due ${suffix}`,
          origin: "owner_request",
          ownerQuote: "track the report",
          idempotencyKey: `invalid-due-${suffix}`,
          due: { kind: "date", on: "2026-11-01" },
        },
        "due.sourceExcerpt",
      );
      await invalid("read_task", {}, "ref");
      assert.deepEqual(kinds, [], "failed calls never invalidate");
      const created = await pool.query(
        "SELECT count(*)::int AS count FROM brain_tasks WHERE owner_id = $1",
        [ownerId],
      );
      assert.equal(created.rows[0].count, 0);

      // Valid input still reaches the service and parses its defaults.
      const listed = await client.callTool({
        name: "list_tasks",
        arguments: {},
      });
      assert.equal(listed.isError, undefined, JSON.stringify(listed.content));
    } finally {
      await client.close().catch(() => undefined);
      for (const [key, value] of [
        ["BRAIN_OWNER_EMAIL", saved.owner],
        ["BRAIN_QUERY_EMBEDDINGS", saved.embeddings],
      ] as const)
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      for (const table of [
        "brain_task_events",
        "brain_tasks",
        "brain_task_settings",
      ])
        await pool.query(`DELETE FROM ${table} WHERE owner_id = $1`, [ownerId]);
      await pool.query('DELETE FROM "user" WHERE id = $1', [ownerId]);
      await pool.query("DELETE FROM brain_agents WHERE owner_id = $1", [
        ownerId,
      ]);
      await pool.end();
    }
  },
);
