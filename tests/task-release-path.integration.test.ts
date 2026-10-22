import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { Principal } from "../lib/auth-principal";
import * as brain from "../lib/brain/service";
import { getPool } from "../lib/db";
import { createBrainHandler } from "../lib/mcp/server";
import { ownerActor } from "../lib/tasks/actors";
import { createTask, readTask } from "../lib/tasks/service";
import type { CacheInvalidation } from "../lib/workspace/cache";

// Release criterion 5 end to end: the owner creates T-1 in the app, Claude
// Code claims it over MCP, reads the brief, writes a page and completes it.
// The task ends done with a produced link and an attributed history; the
// revision is signed by the agent and no task text reaches brain_pages.

test(
  "release path: owner-created T-1 is claimed, worked and completed over MCP",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 120_000 },
  async () => {
    const pool = getPool();
    const ownerId = randomUUID();
    const email = `task-release-${ownerId}@example.invalid`;
    const suffix = ownerId.slice(0, 8);
    const saved = {
      owner: process.env.BRAIN_OWNER_EMAIL,
      embeddings: process.env.BRAIN_QUERY_EMBEDDINGS,
      tasks: process.env.TASKS_ENABLED,
    };
    process.env.BRAIN_OWNER_EMAIL = [saved.owner, email]
      .filter(Boolean)
      .join(",");
    process.env.BRAIN_QUERY_EMBEDDINGS = "false";
    process.env.TASKS_ENABLED = "1";
    await pool.query(
      `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Release Owner',$2,true,now(),now())`,
      [ownerId, email],
    );
    const principal: Principal = {
      ownerId,
      scopes: ["brain:read", "brain:write"],
      kind: "oauth",
      clientId: `claude-code-${suffix}`,
    };
    const kinds: CacheInvalidation[] = [];
    const handler = createBrainHandler(principal, (kind) => kinds.push(kind));
    const client = new Client(
      { name: "task-release-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      const owner = await ownerActor(ownerId);
      // The workspace editor saves pages as the owner agent.
      const project = await brain.write(
        ownerId,
        {
          title: `Clinical dashboard ${suffix}`,
          type: "project",
          markdown: "Scope: a monthly monitoring dashboard for the client.",
          expectedVersion: 0,
        },
        { actorAgentId: owner.agentId },
      );
      const title = `Draft the monitoring plan ${suffix}`;
      const created = await createTask(owner, {
        title,
        projectRef: project.slug,
        acceptanceCriteria: ["The plan lists the monthly checks"],
        expectedOutput: "page",
      });
      assert.equal(created.task.ref, "T-1");
      assert.equal(created.status, "ready");
      assert.equal(created.approved, true);
      assert.equal(created.task.title.untrusted, false);

      await client.connect(
        new StreamableHTTPClientTransport(
          new URL("https://brain.example/mcp"),
          { fetch: (input, init) => handler.fetch(new Request(input, init)) },
        ),
      );
      const call = async (name: string, args: Record<string, unknown>) => {
        const response = await client.callTool({ name, arguments: args });
        assert.equal(
          response.isError,
          undefined,
          `${name}: ${JSON.stringify(response.content)}`,
        );
        return (response.structuredContent as { data: Record<string, unknown> })
          .data;
      };

      const claimed = (await call("claim_task", { ref: "T-1" })) as {
        leaseId: string;
        claimedFrom: string;
        brief: { markdown: string; citations: { id: string }[] };
      };
      assert.match(claimed.leaseId, /\S{16,}/);
      assert.equal(claimed.brief.citations[0]?.id, project.id);
      assert.ok(
        claimed.brief.markdown.includes("monthly monitoring dashboard"),
      );

      const read = (await call("read_task", {
        ref: "T-1",
        includeBrief: true,
      })) as {
        task: { status: string; claimedBy: { label: string } | null };
        you: { holder: boolean; creator: boolean };
        brief: { citations: { id: string }[] };
      };
      assert.equal(read.task.status, "in_progress");
      assert.deepEqual(read.you, { holder: true, creator: false });
      assert.equal(read.task.claimedBy?.label, principal.clientId);
      assert.ok(read.brief.citations.some((page) => page.id === project.id));
      assert.ok(!JSON.stringify(read).includes(claimed.leaseId));

      const plan = (await call("write", {
        title: `Monitoring plan ${suffix}`,
        type: "note",
        markdown: "Monthly checks: data freshness, missing sites, outliers.",
        links: [{ type: "relates_to", targetRef: project.id }],
        expectedVersion: 0,
      })) as { id: string; version: number };

      const done = (await call("complete_task", {
        ref: "T-1",
        leaseId: claimed.leaseId,
        summary: "Plan written in the monitoring note.",
        criteria: [
          {
            index: 0,
            status: "met",
            evidence: "The note lists three monthly checks.",
            verification: "observed",
          },
        ],
        pagesChanged: [{ ref: plan.id, version: plan.version }],
      })) as {
        status: string;
        producedLinks: { pageId: string; status: string }[];
        ignoredPages: unknown[];
      };
      assert.equal(done.status, "done");
      assert.deepEqual(
        done.producedLinks.map((link) => [link.pageId, link.status]),
        [[plan.id, "active"]],
      );
      assert.deepEqual(done.ignoredPages, []);
      // Task tools expire only the task views; the page write only knowledge.
      assert.deepEqual(kinds, ["tasks", "workspace", "tasks"]);

      const final = await readTask(owner, { ref: "T-1", eventsLimit: 50 });
      assert.equal(final.task.status, "done");
      assert.ok(
        final.links.some(
          (link) =>
            link.role === "produced" &&
            link.status === "active" &&
            link.page.id === plan.id,
        ),
      );
      const history = final.events.map((event) => [
        event.action,
        event.actor.kind,
        event.actor.label,
      ]);
      const ownerLabel = owner.agent.label;
      assert.deepEqual(history[0], ["created", "owner", ownerLabel]);
      for (const action of ["claimed", "completed"])
        assert.ok(
          history.some(
            ([name, kind, label]) =>
              name === action &&
              kind === "agent" &&
              label === principal.clientId,
          ),
          action,
        );
      assert.ok(final.events.every((event) => event.actor.label));

      const signers = await pool.query(
        `SELECT r.page_id, a.kind, a.label FROM brain_revisions r
           JOIN brain_agents a ON a.owner_id = r.owner_id AND a.id = r.actor_agent_id
          WHERE r.owner_id = $1 ORDER BY r.created_at`,
        [ownerId],
      );
      assert.deepEqual(
        signers.rows.map((row) => [row.page_id, row.kind, row.label]),
        [
          [project.id, "owner", ownerLabel],
          [plan.id, "agent", principal.clientId],
        ],
      );
      const leaked = await pool.query(
        "SELECT count(*)::int AS n FROM brain_pages WHERE owner_id = $1 AND (markdown ILIKE $2 OR title ILIKE $2)",
        [ownerId, `%${title}%`],
      );
      assert.equal(leaked.rows[0].n, 0, "task text never enters brain_pages");
    } finally {
      await client.close().catch(() => undefined);
      for (const [key, value] of [
        ["BRAIN_OWNER_EMAIL", saved.owner],
        ["BRAIN_QUERY_EMBEDDINGS", saved.embeddings],
        ["TASKS_ENABLED", saved.tasks],
      ] as const)
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      for (const table of [
        "brain_task_events",
        "brain_task_links",
        "brain_tasks",
        "brain_task_settings",
        "brain_pages",
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
