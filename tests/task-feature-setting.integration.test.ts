import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { HookNotFoundError } from "workflow/errors";
import { GET as graphGET } from "../app/api/brain/graph/route";
import { GET as changesGET } from "../app/api/tasks/changes/route";
import { POST as mcpPOST } from "../app/mcp/route";
import { createAgentToken } from "../lib/agent-tokens";
import * as brain from "../lib/brain/service";
import { BrainError } from "../lib/brain/types";
import { getPool } from "../lib/db";
import { enabledWorkflowJobKinds } from "../lib/maintenance/jobs";
import {
  type StartDeps,
  startNightlyMaintenance,
  startTaskMaintenance,
} from "../lib/maintenance/start";
import {
  BRAIN_INSTRUCTIONS,
  BRAIN_INSTRUCTIONS_PRE_TASKS,
} from "../lib/mcp/server";
import { exportBrain } from "../lib/operations";
import { ownerActor, resolveActor, systemActor } from "../lib/tasks/actors";
import {
  setTasksEnabled,
  tasksEnabledAccountCount,
  tasksEnabledFor,
} from "../lib/tasks/feature";
import { TASK_TOOL_NAMES } from "../lib/tasks/mcp-tools";
import { closeTask } from "../lib/tasks/owner";
import { createTask } from "../lib/tasks/service";
import { saveTaskView } from "../lib/tasks/settings";

// The task manager is a per-owner setting that starts off. Two allowlisted
// owners share this process: "on" turns it on, "off" never does. Each must see
// only what their own setting allows, over the real /mcp route and the
// workspace API, in the export and when maintenance starts.

const code = (expected: string) => (error: unknown) =>
  error instanceof BrainError && error.code === expected;

const SIDES = ["on", "off"] as const;
type Side = (typeof SIDES)[number];

test(
  "task manager setting: off by default, owner-only and independent per owner",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 120_000 },
  async (t) => {
    const pool = getPool();
    const ids = { on: randomUUID(), off: randomUUID() };
    const emails = {
      on: `task-feature-on-${ids.on}@example.invalid`,
      off: `task-feature-off-${ids.off}@example.invalid`,
    };
    const suffix = ids.on.slice(0, 8);
    const saved = {
      owner: process.env.BRAIN_OWNER_EMAIL,
      embeddings: process.env.BRAIN_QUERY_EMBEDDINGS,
    };
    const allowlist = [saved.owner, emails.on, emails.off]
      .filter(Boolean)
      .join(",");
    process.env.BRAIN_OWNER_EMAIL = allowlist;
    process.env.BRAIN_QUERY_EMBEDDINGS = "false";
    // Route handlers run outside Next's request context in this harness.
    const nextCache = createRequire(import.meta.url)("next/cache");
    t.mock.method(nextCache, "revalidateTag", () => undefined);
    t.mock.method(nextCache, "updateTag", () => undefined);
    for (const side of SIDES)
      await pool.query(
        `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Feature Owner',$2,true,now(),now())`,
        [ids[side], emails[side]],
      );
    const clients: Client[] = [];
    try {
      const owners = {
        on: await ownerActor(ids.on),
        off: await ownerActor(ids.off),
      };
      const tokens = {
        on: (
          await createAgentToken(ids.on, {
            name: "Feature agent",
            scopes: ["brain:read", "brain:write"],
          })
        ).token,
        off: (
          await createAgentToken(ids.off, {
            name: "Feature agent",
            scopes: ["brain:read", "brain:write"],
          })
        ).token,
      };
      const connect = async (side: Side) => {
        const client = new Client(
          { name: `task-feature-${side}`, version: "1.0.0" },
          { versionNegotiation: { mode: { pin: "2026-07-28" } } },
        );
        await client.connect(
          new StreamableHTTPClientTransport(
            new URL("https://brain.example/mcp"),
            {
              requestInit: {
                headers: { authorization: `Bearer ${tokens[side]}` },
              },
              fetch: async (input, init) => {
                const request = new Request(input, init);
                return request.method === "POST"
                  ? mcpPOST(request)
                  : new Response(null, { status: 405 });
              },
            },
          ),
        );
        clients.push(client);
        return client;
      };
      const taskTools = async (client: Client) =>
        (await client.listTools()).tools
          .map((tool) => tool.name)
          .filter((name) => TASK_TOOL_NAMES.has(name));
      const data = async (
        client: Client,
        name: string,
        args: Record<string, unknown>,
      ) => {
        const response = await client.callTool({ name, arguments: args });
        assert.equal(
          response.isError,
          undefined,
          JSON.stringify(response.content),
        );
        return (response.structuredContent as { data: Record<string, unknown> })
          .data;
      };
      const api = async (
        handler: (request: Request) => Promise<Response>,
        side: Side,
        path: string,
      ) => {
        const response = await handler(
          new Request(`https://brain.example${path}`, {
            headers: { authorization: `Bearer ${tokens[side]}` },
          }),
        );
        return { status: response.status, body: await response.json() };
      };

      await t.test("a new owner starts with the task manager off", async () => {
        for (const side of SIDES)
          assert.equal(await tasksEnabledFor(ids[side]), false, side);
        // Other task settings create the row without turning tasks on.
        await saveTaskView(owners.off, { name: "Mine", query: "priority=1" });
        const { rows } = await pool.query(
          "SELECT enabled FROM brain_task_settings WHERE owner_id = $1",
          [ids.off],
        );
        assert.deepEqual(rows, [{ enabled: false }]);
        assert.equal(await tasksEnabledFor(ids.off), false);
        await assert.rejects(tasksEnabledFor(""), code("UNAUTHORIZED"));
      });

      await t.test(
        "only the owner turns it on or off, and only their own",
        async () => {
          const agent = await resolveActor(ids.on, {
            ownerId: ids.on,
            scopes: ["brain:read", "brain:write"],
            kind: "oauth",
            clientId: `feature-agent-${suffix}`,
          });
          const keeper = await systemActor(ids.on, "task_keeper");
          for (const actor of [agent, keeper]) {
            await assert.rejects(
              setTasksEnabled(actor, true),
              code("NOT_ALLOWED"),
            );
            await assert.rejects(
              setTasksEnabled(actor, false),
              code("NOT_ALLOWED"),
            );
          }
          assert.equal(await tasksEnabledFor(ids.on), false);
          assert.deepEqual(await setTasksEnabled(owners.on, true), {
            enabled: true,
          });
          assert.deepEqual(
            await setTasksEnabled(owners.on, true),
            { enabled: true },
            "turning it on twice is harmless",
          );
          assert.equal(await tasksEnabledFor(ids.on), true);
          assert.equal(
            await tasksEnabledFor(ids.off),
            false,
            "another owner's setting is untouched",
          );
        },
      );

      // Both owners get a project with an open and a closed task. The "off"
      // owner's tasks stand for tasks created before the setting was turned
      // off: hidden from every surface, never deleted.
      const fixtures = async (side: Side) => {
        const owner = owners[side];
        const project = await brain.write(
          ids[side],
          {
            title: `Quarterly report ${side} ${suffix}`,
            type: "project",
            markdown: "Quarterly report for the client.",
            expectedVersion: 0,
          },
          { actorAgentId: owner.agentId },
        );
        const create = async (title: string) =>
          (
            await createTask(owner, {
              title: `${title} ${side} ${suffix}`,
              projectRef: project.id,
            })
          ).task;
        const open = await create("Draft the report");
        const closed = await create("Collect the data");
        await closeTask(owner, closed.ref);
        return { project, open, closed };
      };
      const pages = { on: await fixtures("on"), off: await fixtures("off") };
      const mcp = { on: await connect("on"), off: await connect("off") };

      await t.test(
        "two owners in one process get their own MCP tools, resources and instructions",
        async () => {
          for (const side of SIDES) {
            const client = mcp[side];
            const enabled = side === "on";
            const { tools } = await client.listTools();
            assert.equal(tools.length, enabled ? 19 : 11, side);
            assert.equal((await taskTools(client)).length, enabled ? 8 : 0);
            const { resources } = await client.listResources();
            assert.equal(
              resources.some(
                (resource) => resource.uri === "brain://procedures/tasks",
              ),
              enabled,
              side,
            );
            const instructions = enabled
              ? BRAIN_INSTRUCTIONS
              : BRAIN_INSTRUCTIONS_PRE_TASKS;
            assert.equal(client.getInstructions(), instructions, side);
            const [procedure] = (
              await client.readResource({ uri: "brain://procedures" })
            ).contents;
            assert.equal(
              "text" in procedure ? procedure.text : "",
              instructions,
              side,
            );
          }
          // A task tool called by name is not there for the owner with it off.
          await assert.rejects(
            mcp.off.callTool({
              name: "read_task",
              arguments: { ref: pages.off.open.ref },
            }),
            /Tool read_task not found/,
          );
          const read = await data(mcp.on, "read_task", {
            ref: pages.on.open.ref,
          });
          assert.ok(JSON.stringify(read).includes(pages.on.open.ref));
        },
      );

      await t.test(
        "openTasks rides on read and context only for the owner with it on",
        async () => {
          for (const side of SIDES) {
            const enabled = side === "on";
            const { project, open } = pages[side];
            const read = await data(mcp[side], "read", { ref: project.id });
            const bundle = await data(mcp[side], "context", {
              query: "Quarterly report",
              refs: [project.id],
            });
            for (const result of [read, bundle]) {
              const openTasks = result.openTasks as
                | { tasks: { ref: string }[] }
                | undefined;
              if (enabled)
                assert.deepEqual(
                  openTasks?.tasks.map((task) => task.ref),
                  [open.ref],
                );
              else assert.equal("openTasks" in result, false, side);
            }
          }
        },
      );

      await t.test(
        "a change applies to the owner's next MCP request and deletes nothing",
        async () => {
          await setTasksEnabled(owners.off, true);
          assert.equal((await taskTools(mcp.off)).length, 8);
          const shown = await data(mcp.off, "read", {
            ref: pages.off.project.id,
          });
          assert.deepEqual(
            (shown.openTasks as { tasks: { ref: string }[] }).tasks.map(
              (task) => task.ref,
            ),
            [pages.off.open.ref],
          );
          await setTasksEnabled(owners.off, false);
          assert.deepEqual(await taskTools(mcp.off), []);
          assert.equal(
            "openTasks" in
              (await data(mcp.off, "read", { ref: pages.off.project.id })),
            false,
          );
          assert.equal(
            (await taskTools(mcp.on)).length,
            8,
            "the other owner is unaffected",
          );
          const { rows } = await pool.query(
            "SELECT count(*)::int AS count FROM brain_tasks WHERE owner_id = $1",
            [ids.off],
          );
          assert.equal(rows[0].count, 2, "turning it off deletes no task");
        },
      );

      await t.test(
        "the export carries closed tasks only for the owner with it on",
        async () => {
          const on = await exportBrain(ids.on);
          assert.equal(on.schemaVersion, 2);
          assert.ok("tasks" in on);
          assert.deepEqual(
            on.tasks.map((task) => task.ref),
            [pages.on.closed.ref],
          );
          const off = await exportBrain(ids.off);
          assert.equal(off.schemaVersion, 1);
          assert.equal("tasks" in off, false);
          assert.equal(off.pages.length, 1);
          assert.doesNotMatch(JSON.stringify(off), /Collect the data/);
        },
      );

      await t.test(
        "the changes poll and the graph overlay follow each owner's setting",
        async () => {
          const onPoll = await api(changesGET, "on", "/api/tasks/changes");
          assert.equal(onPoll.status, 200);
          assert.equal(typeof onPoll.body.needsYou, "number");
          const offPoll = await api(changesGET, "off", "/api/tasks/changes");
          assert.equal(offPoll.status, 404);
          assert.equal(offPoll.body.code, "NOT_FOUND");

          const onGraph = await api(graphGET, "on", "/api/brain/graph?tasks=1");
          assert.equal(onGraph.status, 200);
          assert.deepEqual(
            onGraph.body.taskOverlay.tasks.map(
              (task: { ref: string }) => task.ref,
            ),
            [pages.on.open.ref],
          );
          const plain = await api(graphGET, "on", "/api/brain/graph");
          assert.equal("taskOverlay" in plain.body, false);
          const offGraph = await api(
            graphGET,
            "off",
            "/api/brain/graph?tasks=1",
          );
          assert.equal(offGraph.status, 200);
          assert.equal("taskOverlay" in offGraph.body, false);
          assert.equal(offGraph.body.nodes.length, 1);
        },
      );

      await t.test(
        "maintenance reads each owner's setting when a run starts",
        async () => {
          const queued: unknown[][] = [];
          const started: unknown[][] = [];
          const deps: StartDeps = {
            tasksEnabled: (ownerId) => tasksEnabledFor(ownerId),
            now: () => new Date("2026-10-21T20:00:00Z"),
            start: async (_workflow, args) => {
              started.push(args);
              return { runId: `wrun-${started.length}` };
            },
            getHookByToken: async (token) => {
              throw new HookNotFoundError(token);
            },
            dailyWorkflowStatus: async () => [],
            queueWorkflowJobs: async (...args) => {
              queued.push(args);
            },
            requeueTaskWorkflowJobs: async () => {
              throw new Error("Run now must be refused before requeueing");
            },
          };
          for (const side of SIDES)
            await startNightlyMaintenance(ids[side], "scheduled", deps);
          assert.deepEqual(
            queued.map((args) => [args[0], args[3]]),
            [
              [ids.on, enabledWorkflowJobKinds(true)],
              [ids.off, enabledWorkflowJobKinds(false)],
            ],
          );
          assert.deepEqual(
            started.map((args) => args[3]),
            [
              { scope: "nightly", tasks: true },
              { scope: "nightly", tasks: false },
            ],
          );
          await assert.rejects(
            startTaskMaintenance(ids.off, deps),
            code("TASKS_DISABLED"),
          );
          assert.equal(started.length, 2, "a refused Run now starts nothing");
        },
      );

      await t.test(
        "only allowlisted owners with it on count toward the task budget",
        async () => {
          // Scope the allowlist to these two owners so other accounts in the
          // database cannot change the count.
          process.env.BRAIN_OWNER_EMAIL = `${emails.on},${emails.off}`;
          try {
            assert.equal(await tasksEnabledAccountCount(), 1);
            await setTasksEnabled(owners.off, true);
            assert.equal(await tasksEnabledAccountCount(), 2);
            process.env.BRAIN_OWNER_EMAIL = emails.on;
            assert.equal(
              await tasksEnabledAccountCount(),
              1,
              "an account removed from the allowlist no longer counts",
            );
          } finally {
            process.env.BRAIN_OWNER_EMAIL = allowlist;
            await setTasksEnabled(owners.off, false);
          }
        },
      );
    } finally {
      for (const client of clients) await client.close().catch(() => {});
      for (const [name, value] of [
        ["BRAIN_OWNER_EMAIL", saved.owner],
        ["BRAIN_QUERY_EMBEDDINGS", saved.embeddings],
      ] as const)
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      for (const ownerId of Object.values(ids)) {
        for (const table of [
          "brain_task_events",
          "brain_task_links",
          "brain_tasks",
          "brain_task_settings",
          "brain_activity",
          "brain_revisions",
          "brain_pages",
          "brain_agent_clients",
          "agent_tokens",
          "brain_agents",
        ])
          await pool.query(`DELETE FROM ${table} WHERE owner_id = $1`, [
            ownerId,
          ]);
        await pool.query('DELETE FROM "user" WHERE id = $1', [ownerId]);
      }
      await pool.end();
    }
  },
);
