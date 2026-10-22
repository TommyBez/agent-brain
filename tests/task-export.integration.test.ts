import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import * as brain from "../lib/brain/service";
import { getGraph } from "../lib/brain/service";
import { getPool } from "../lib/db";
import { loadTaskOverlay } from "../lib/graph/task-overlay-query";
import { exportBrain } from "../lib/operations";
import { ownerActor, systemActor } from "../lib/tasks/actors";
import {
  archiveTask,
  cancelTask,
  closeTask,
  purgeTask,
} from "../lib/tasks/owner";
import { createTask } from "../lib/tasks/service";

test(
  "closed-task export (schemaVersion 2) and the graph task overlay",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 120_000 },
  async (t) => {
    const pool = getPool();
    const ownerId = randomUUID();
    const email = `task-export-${ownerId}@example.invalid`;
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
      `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Export Owner',$2,true,now(),now())`,
      [ownerId, email],
    );
    try {
      const owner = await ownerActor(ownerId);
      const page = (title: string, type: "project" | "note") =>
        brain.write(
          ownerId,
          {
            title: `${title} ${suffix}`,
            type,
            markdown: `${title} body.`,
            expectedVersion: 0,
          },
          { actorAgentId: owner.agentId },
        );
      const project = await page("Clinical report", "project");
      const note = await page("Minutes", "note");
      const other = await page("Unrelated", "note");
      const create = async (title: string, fields = {}) =>
        (
          await createTask(owner, {
            title: `${title} ${suffix}`,
            ...fields,
          })
        ).task;
      const done = await create("Export alpha", {
        description: "Alpha description",
        acceptanceCriteria: ["Report sent"],
        projectRef: project.id,
        contextPageRefs: [note.id],
        priority: 1,
      });
      const canceled = await create("Export beta", {
        contextPageRefs: [note.id],
      });
      const open = await create("Export open", {
        projectRef: project.id,
        contextPageRefs: [note.id],
      });
      const confidential = await create("Export confidential", {
        description: "Riservato",
      });
      const archived = await create("Export archived", {
        contextPageRefs: [note.id],
      });
      const suggestedOnly = await create("Export suggested only");
      await closeTask(owner, done.ref, { note: "Sent to the client" });
      await cancelTask(owner, canceled.ref);
      await closeTask(owner, confidential.ref);
      await archiveTask(owner, archived.ref, true);
      const conciliator = await systemActor(ownerId, "consolidator");
      for (const [taskId, pageId] of [
        [done.id, other.id],
        [open.id, other.id],
        [suggestedOnly.id, note.id],
      ])
        await pool.query(
          `INSERT INTO brain_task_links (owner_id, task_id, page_id, role, origin, status, confidence, created_by_agent_id)
           VALUES ($1, $2, $3, 'decision', 'consolidator', 'suggested', 0.9, $4)`,
          [ownerId, taskId, pageId, conciliator.agentId],
        );

      await t.test(
        "only done and canceled tasks are exported, with active links and an events summary",
        async () => {
          const snapshot = await exportBrain(ownerId);
          assert.equal(snapshot.schemaVersion, 2);
          assert.ok("tasks" in snapshot);
          const tasks = snapshot.tasks;
          assert.deepEqual(
            tasks.map((task) => task.ref),
            [done.ref, canceled.ref, confidential.ref],
          );
          const alpha = tasks[0];
          assert.equal(alpha.status, "done");
          assert.equal(alpha.title, `Export alpha ${suffix}`);
          assert.equal(alpha.description, "Alpha description");
          assert.deepEqual(alpha.acceptanceCriteria, ["Report sent"]);
          assert.equal(alpha.project, project.slug);
          assert.equal(alpha.priority, 1);
          assert.equal(alpha.createdBy, owner.agent.label);
          assert.ok(alpha.completedAt);
          assert.deepEqual(
            alpha.links.map((link) => [link.page, link.role]),
            [[note.slug, "context"]],
            "Suggested links stay out of the export",
          );
          assert.equal(alpha.history.byAction.created, 1);
          assert.equal(alpha.history.byAction.status_changed, 1);
          assert.deepEqual(
            alpha.history.timeline.map((event) => [event.action, event.to]),
            [
              ["created", "ready"],
              ["status_changed", "done"],
            ],
          );
          assert.equal(tasks[1].status, "canceled");
          const serialized = JSON.stringify(snapshot);
          assert.doesNotMatch(serialized, /lease_?id|leaseId|idempotency/i);
          assert.doesNotMatch(serialized, /Export open|Export archived/);
          for (const exported of snapshot.pages)
            assert.doesNotMatch(
              `${exported.title} ${exported.markdown}`,
              /Export (alpha|beta|open|confidential)/,
            );
        },
      );

      await t.test("task text never enters brain_pages or chunks", async () => {
        const { rows } = await pool.query(
          `SELECT
             (SELECT count(*)::int FROM brain_pages WHERE owner_id = $1
                AND (title ILIKE '%Export %' OR markdown ILIKE '%Export %' OR markdown ILIKE '%Riservato%')) AS pages,
             (SELECT count(*)::int FROM brain_page_chunks WHERE owner_id = $1
                AND (content ILIKE '%Export %' OR content ILIKE '%Riservato%')) AS chunks,
             (SELECT count(*)::int FROM brain_pages WHERE owner_id = $1) AS total`,
          [ownerId],
        );
        assert.deepEqual(rows[0], { pages: 0, chunks: 0, total: 3 });
      });

      await t.test("a purged task is absent from the next export", async () => {
        await purgeTask(owner, confidential.ref);
        const snapshot = await exportBrain(ownerId);
        assert.equal(snapshot.schemaVersion, 2);
        assert.deepEqual(
          snapshot.tasks.map((task) => task.ref),
          [done.ref, canceled.ref],
        );
        assert.doesNotMatch(JSON.stringify(snapshot), /Riservato|confidential/);
      });

      await t.test(
        "with TASKS_ENABLED off the export stays schemaVersion 1",
        async () => {
          process.env.TASKS_ENABLED = "false";
          try {
            const snapshot = await exportBrain(ownerId);
            assert.equal(snapshot.schemaVersion, 1);
            assert.equal("tasks" in snapshot, false);
            assert.equal(snapshot.pages.length, 3);
          } finally {
            process.env.TASKS_ENABLED = "1";
          }
        },
      );

      await t.test(
        "the overlay is a separate read that never takes a place in the page window",
        async () => {
          const graph = await getGraph(ownerId, { limit: 2, offset: 0 });
          assert.equal(graph.nodes.length, 2);
          assert.equal(graph.total, 3);
          const ids = graph.nodes.map((node) => node.id);
          const overlay = await loadTaskOverlay(ownerId, [
            ...ids,
            "not-a-uuid",
          ]);
          const again = await getGraph(ownerId, { limit: 2, offset: 0 });
          assert.deepEqual(again, graph);
          const visible = new Set(ids);
          // Only open, unarchived tasks anchored to the pages in the window.
          const expected = [open].filter(
            () => visible.has(project.id) || visible.has(note.id),
          );
          assert.deepEqual(
            overlay.tasks.map((task) => task.ref),
            expected.map((task) => task.ref),
          );
          assert.equal(overlay.total, expected.length);
          assert.ok(overlay.links.every((link) => visible.has(link.pageId)));
          const everything = await loadTaskOverlay(ownerId, [
            project.id,
            note.id,
            other.id,
          ]);
          assert.deepEqual(
            everything.tasks.map((task) => task.ref),
            [open.ref],
            "Closed, archived and suggestion-only tasks stay out",
          );
          assert.equal(everything.tasks[0].untrusted, false);
          assert.equal(everything.tasks[0].status, "ready");
          const roles = everything.links
            .filter((link) => link.taskId === open.id)
            .map((link) => `${link.role}:${link.status}:${link.pageId}`)
            .sort();
          for (const expectedRole of [
            `project:active:${project.id}`,
            `context:active:${note.id}`,
            `decision:suggested:${other.id}`,
          ])
            assert.ok(roles.includes(expectedRole), expectedRole);
          const limited = await loadTaskOverlay(ownerId, [note.id], 0);
          assert.deepEqual(limited.tasks, []);
          assert.deepEqual(await loadTaskOverlay(ownerId, []), {
            tasks: [],
            links: [],
            total: 0,
          });
          const foreign = await loadTaskOverlay(randomUUID(), [note.id]);
          assert.deepEqual(foreign.tasks, []);
        },
      );
    } finally {
      for (const [name, value] of [
        ["BRAIN_OWNER_EMAIL", saved.owner],
        ["BRAIN_QUERY_EMBEDDINGS", saved.embeddings],
        ["TASKS_ENABLED", saved.tasks],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      for (const table of [
        "brain_task_events",
        "brain_tasks",
        "brain_task_extraction_rejections",
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
