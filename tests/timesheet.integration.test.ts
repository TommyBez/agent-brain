import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { getPool } from "../lib/db";
import { createBrainHandler } from "../lib/mcp/server";
import { ownerActor } from "../lib/tasks/actors";
import {
  createTimeEntry,
  deleteTimeEntry,
  listTimeEntries,
  readTimeEntry,
  updateTimeEntry,
} from "../lib/timesheet/service";
import type { CacheInvalidation } from "../lib/workspace/cache";

test(
  "timesheet persists CRUD, ownership, concurrency, retry safety, totals and real MCP calls",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 60000 },
  async (t) => {
    const db = getPool();
    const owner = randomUUID();
    const other = randomUUID();
    const project = randomUUID();
    const note = randomUUID();
    const otherProject = randomUUID();
    const savedAllowlist = process.env.BRAIN_OWNER_EMAIL;
    process.env.BRAIN_OWNER_EMAIL = [
      savedAllowlist,
      `${owner}@example.invalid`,
      `${other}@example.invalid`,
    ]
      .filter(Boolean)
      .join(",");
    let client: Client | undefined;
    try {
      for (const id of [owner, other])
        await db.query(
          `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Timesheet test',$2,true,now(),now())`,
          [id, `${id}@example.invalid`],
        );
      for (const [id, ownerId, type] of [
        [project, owner, "project"],
        [note, owner, "note"],
        [otherProject, other, "project"],
      ])
        await db.query(
          "INSERT INTO brain_pages (id,owner_id,slug,type,title,markdown) VALUES ($1,$2,$3,$4,'Timesheet project','Fixture')",
          [id, ownerId, `${type}/${id}`, type],
        );
      const actor = await ownerActor(owner);
      const otherActor = await ownerActor(other);
      const input = {
        workedOn: "2026-11-16",
        minutes: 90,
        note: "Implementation",
        projectRef: `project/${project}`,
        idempotencyKey: randomUUID(),
      };
      const { entry } = await createTimeEntry(actor, input);
      const unassigned = await createTimeEntry(actor, {
        workedOn: "2026-11-15",
        minutes: 45,
        idempotencyKey: randomUUID(),
      });

      await t.test(
        "filters, inclusive dates and totals span all pages",
        async () => {
          const list = await listTimeEntries(owner, { limit: 1 });
          assert.equal(list.entries.length, 1);
          assert.equal(list.total, 2);
          assert.equal(list.totalMinutes, 135);
          assert.equal(list.nextOffset, 1);
          assert.equal(
            (await listTimeEntries(owner, { limit: 1, offset: 1 })).entries[0]
              .id,
            unassigned.entry.id,
          );
          assert.equal(
            (await listTimeEntries(owner, { offset: 10 })).totalMinutes,
            135,
          );
          assert.equal(
            (await listTimeEntries(owner, { projectRef: null })).totalMinutes,
            45,
          );
          assert.equal(
            (await listTimeEntries(owner, { projectRef: project }))
              .totalMinutes,
            90,
          );
          assert.equal(
            (
              await listTimeEntries(owner, {
                from: "2026-11-16",
                to: "2026-11-16",
              })
            ).totalMinutes,
            90,
          );
          assert.equal(
            (await listTimeEntries(owner, { to: "2026-11-14" })).totalMinutes,
            0,
          );
        },
      );

      await t.test(
        "foreign owners and non-project pages are rejected without writes",
        async () => {
          assert.equal((await listTimeEntries(other, {})).total, 0);
          await assert.rejects(readTimeEntry(other, { id: entry.id }), {
            code: "TIME_ENTRY_NOT_FOUND",
          });
          await assert.rejects(
            updateTimeEntry(otherActor, {
              id: entry.id,
              expectedVersion: 1,
              patch: { minutes: 5 },
            }),
            { code: "TIME_ENTRY_NOT_FOUND" },
          );
          await assert.rejects(
            deleteTimeEntry(otherActor, { id: entry.id, expectedVersion: 1 }),
            { code: "TIME_ENTRY_NOT_FOUND" },
          );
          for (const projectRef of [note, otherProject, randomUUID()])
            await assert.rejects(
              createTimeEntry(actor, {
                ...input,
                projectRef,
                idempotencyKey: randomUUID(),
              }),
              { code: "PROJECT_NOT_FOUND" },
            );
          assert.equal((await listTimeEntries(owner, {})).total, 2);
          await assert.rejects(
            db.query(
              "UPDATE brain_time_entries SET project_id = $1 WHERE id = $2",
              [otherProject, entry.id],
            ),
            { code: "23503" },
          );
          await assert.rejects(
            db.query(
              "UPDATE brain_time_entries SET project_id = $1 WHERE id = $2",
              [note, entry.id],
            ),
            { code: "23503" },
          );
          await assert.rejects(
            db.query(
              "UPDATE brain_time_entries SET minutes = 0 WHERE id = $1",
              [entry.id],
            ),
            { code: "23514" },
          );
        },
      );

      await t.test(
        "concurrent retries create one entry and conflicting keys fail",
        async () => {
          const concurrent = { ...input, idempotencyKey: randomUUID() };
          const results = await Promise.all([
            createTimeEntry(actor, concurrent),
            createTimeEntry(actor, concurrent),
          ]);
          assert.equal(results[0].entry.id, results[1].entry.id);
          assert.equal(results.filter((result) => result.replayed).length, 1);
          await assert.rejects(
            createTimeEntry(actor, { ...input, minutes: 100 }),
            { code: "IDEMPOTENCY_KEY_CONFLICT" },
          );
          await deleteTimeEntry(actor, {
            id: results[0].entry.id,
            expectedVersion: 1,
          });
        },
      );

      await t.test(
        "updates preserve omitted fields, clear project, and fence concurrent edits/deletion",
        async () => {
          const outcomes = await Promise.allSettled([
            updateTimeEntry(actor, {
              id: entry.id,
              expectedVersion: 1,
              patch: { minutes: 120 },
            }),
            updateTimeEntry(actor, {
              id: entry.id,
              expectedVersion: 1,
              patch: { minutes: 120 },
            }),
          ]);
          assert.equal(
            outcomes.filter((result) => result.status === "fulfilled").length,
            1,
          );
          const rejection = outcomes.find(
            (result) => result.status === "rejected",
          );
          assert.equal(
            rejection?.status === "rejected" && rejection.reason.code,
            "VERSION_CONFLICT",
          );
          await assert.rejects(
            deleteTimeEntry(actor, { id: entry.id, expectedVersion: 1 }),
            { code: "VERSION_CONFLICT" },
          );
          const changed = await updateTimeEntry(actor, {
            id: entry.id,
            expectedVersion: 2,
            patch: { projectRef: null, note: "" },
          });
          assert.equal(changed.projectId, null);
          assert.equal(changed.note, "");
          assert.equal(changed.minutes, 120);
          assert.equal(changed.workedOn, input.workedOn);
          await deleteTimeEntry(actor, { id: entry.id, expectedVersion: 3 });
          assert.equal((await listTimeEntries(owner, {})).totalMinutes, 45);
          const replay = await createTimeEntry(actor, input);
          assert.equal(replay.replayed, true);
          assert.ok(replay.entry.deletedAt);
          assert.equal((await listTimeEntries(owner, {})).total, 1);
        },
      );

      await t.test(
        "MCP CRUD works with tasks disabled and returns fresh totals",
        async () => {
          const invalidations: CacheInvalidation[] = [];
          const handler = createBrainHandler(
            {
              ownerId: owner,
              scopes: ["brain:read", "brain:write"],
              kind: "oauth",
              clientId: `timesheet-${owner}`,
            },
            (kind) => invalidations.push(kind),
            async () => false,
          );
          client = new Client(
            { name: "timesheet-test", version: "1.0.0" },
            { versionNegotiation: { mode: { pin: "2026-07-28" } } },
          );
          await client.connect(
            new StreamableHTTPClientTransport(
              new URL("https://brain.example/mcp"),
              {
                fetch: (request, init) =>
                  handler.fetch(new Request(request, init)),
              },
            ),
          );
          const tools = (await client.listTools()).tools;
          assert.equal(
            tools.filter((tool) => tool.name.includes("time_entr")).length,
            5,
          );
          assert.equal(
            tools.some((tool) => tool.name === "create_task"),
            false,
          );
          const call = async (name: string, args: Record<string, unknown>) => {
            const result = await client?.callTool({ name, arguments: args });
            assert.ok(result);
            assert.ok(!result.isError, JSON.stringify(result));
            return (
              result.structuredContent as { data: Record<string, unknown> }
            ).data;
          };
          const created = await call("create_time_entry", {
            workedOn: "2026-11-16",
            minutes: 30,
            projectRef: project,
            idempotencyKey: randomUUID(),
          });
          const id = (created.entry as { id: string }).id;
          const read = await call("read_time_entry", { id });
          assert.equal(read.minutes, 30);
          const changed = await call("update_time_entry", {
            id,
            expectedVersion: 1,
            patch: { minutes: 60, projectRef: null },
          });
          assert.equal(changed.version, 2);
          assert.equal(changed.projectId, null);
          assert.equal((await call("list_time_entries", {})).totalMinutes, 105);
          const stale = await client?.callTool({
            name: "delete_time_entry",
            arguments: { id, expectedVersion: 1 },
          });
          assert.equal(stale?.isError, true);
          await call("delete_time_entry", { id, expectedVersion: 2 });
          assert.equal((await call("list_time_entries", {})).totalMinutes, 45);
          assert.deepEqual(invalidations, [
            "timesheet",
            "timesheet",
            "timesheet",
          ]);
        },
      );
    } finally {
      await client?.close();
      await db.query(
        "DELETE FROM brain_time_entries WHERE owner_id = ANY($1::text[])",
        [[owner, other]],
      );
      await db.query(
        "DELETE FROM brain_agent_clients WHERE owner_id = ANY($1::text[])",
        [[owner, other]],
      );
      await db.query(
        "DELETE FROM brain_agents WHERE owner_id = ANY($1::text[])",
        [[owner, other]],
      );
      await db.query(
        "DELETE FROM brain_pages WHERE owner_id = ANY($1::text[])",
        [[owner, other]],
      );
      await db.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
        [owner, other],
      ]);
      if (savedAllowlist === undefined) delete process.env.BRAIN_OWNER_EMAIL;
      else process.env.BRAIN_OWNER_EMAIL = savedAllowlist;
      await db.end();
    }
  },
);
