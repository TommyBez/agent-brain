import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getPool } from "../lib/db";
import { ownerActor } from "../lib/tasks/actors";
import {
  addTaskDependency,
  removeTaskDependency,
} from "../lib/tasks/dependencies";
import { blockTask, purgeTask } from "../lib/tasks/owner";
import {
  createTask,
  listTasks,
  readTask,
  updateTask,
} from "../lib/tasks/service";

test(
  "list pagination keeps one watermark; removing the last dependency unblocks",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 120_000 },
  async (t) => {
    const pool = getPool();
    const ownerId = randomUUID();
    const email = `task-pagination-${ownerId}@example.invalid`;
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
      `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Pagination Owner',$2,true,now(),now())`,
      [ownerId, email],
    );
    try {
      const owner = await ownerActor(ownerId);
      const rename = async (ref: string, title: string) => {
        const { task } = await readTask(owner, { ref });
        await updateTask(owner, {
          ref,
          expectedVersion: task.version,
          patch: { title },
        });
      };

      await t.test(
        "a change behind the cursor during a paginated scan reaches the next scan",
        async () => {
          const first = await createTask(owner, {
            title: `First ${suffix}`,
            priority: 1,
          });
          const second = await createTask(owner, {
            title: `Second ${suffix}`,
            priority: 3,
          });
          const start = (await listTasks(owner, { limit: 1 })).eventsCursor;
          await rename(first.task.ref, `First, edited ${suffix}`);
          await rename(second.task.ref, `Second, edited ${suffix}`);

          const page1 = await listTasks(owner, {
            changedSince: start,
            limit: 1,
          });
          assert.deepEqual(
            page1.tasks.map((task) => task.ref),
            [first.task.ref],
          );
          assert.ok(page1.nextCursor);
          // Changes after page 1, behind the cursor in queue order.
          await rename(first.task.ref, `First, edited again ${suffix}`);
          const page2 = await listTasks(owner, {
            changedSince: start,
            cursor: page1.nextCursor,
            limit: 1,
          });
          assert.deepEqual(
            page2.tasks.map((task) => task.ref),
            [second.task.ref],
          );
          assert.equal(page2.nextCursor, null);
          assert.equal(
            page2.eventsCursor,
            page1.eventsCursor,
            "every page of one scan reports the same events cursor",
          );
          const next = await listTasks(owner, {
            changedSince: page2.eventsCursor,
          });
          assert.ok(
            next.tasks.some((task) => task.ref === first.task.ref),
            "the change made between pages is reported by the next scan",
          );
        },
      );

      await t.test(
        "removing the last unfinished dependency releases a dependency block",
        async () => {
          const a = await createTask(owner, {
            title: `Dependency A ${suffix}`,
          });
          const b = await createTask(owner, {
            title: `Dependency B ${suffix}`,
          });
          const blocked = await createTask(owner, {
            title: `Blocked on A and B ${suffix}`,
          });
          await addTaskDependency(owner, blocked.task.ref, a.task.ref);
          await addTaskDependency(owner, blocked.task.ref, b.task.ref);
          await blockTask(owner, blocked.task.ref, { reason: "dependency" });

          const first = await removeTaskDependency(
            owner,
            blocked.task.ref,
            a.task.ref,
          );
          assert.equal(first.unblocked, false);
          let view = await readTask(owner, { ref: blocked.task.ref });
          assert.equal(view.task.status, "blocked", "B is still unfinished");

          const last = await removeTaskDependency(
            owner,
            blocked.task.ref,
            b.task.ref,
          );
          assert.equal(last.unblocked, true);
          view = await readTask(owner, { ref: blocked.task.ref });
          assert.equal(view.task.status, "ready");
          assert.equal(view.task.blockedReason, null);
          const event = view.events.at(-1);
          assert.equal(event?.action, "status_changed");
          assert.equal(event?.payload.cause, "dependencies_removed");
          assert.equal(event?.payload.removed, b.task.ref);

          // A block for another reason is the owner's call, never released here.
          const external = await createTask(owner, {
            title: `Blocked externally ${suffix}`,
          });
          await addTaskDependency(owner, external.task.ref, a.task.ref);
          await blockTask(owner, external.task.ref, { reason: "external" });
          await removeTaskDependency(owner, external.task.ref, a.task.ref);
          assert.equal(
            (await readTask(owner, { ref: external.task.ref })).task.status,
            "blocked",
          );
        },
      );

      await t.test(
        "purging the last unfinished blocker releases its dependents",
        async () => {
          const blocker = await createTask(owner, {
            title: `Purged blocker ${suffix}`,
          });
          const dependent = await createTask(owner, {
            title: `Waits on the purged blocker ${suffix}`,
          });
          await addTaskDependency(owner, dependent.task.ref, blocker.task.ref);
          await blockTask(owner, dependent.task.ref, { reason: "dependency" });
          await purgeTask(owner, blocker.task.ref);
          const view = await readTask(owner, { ref: dependent.task.ref });
          assert.equal(view.task.status, "ready");
          assert.equal(
            view.events.at(-1)?.payload.cause,
            "dependencies_removed",
          );
        },
      );

      await t.test(
        "a cursor watermark never moves past the current one",
        async () => {
          const forged = Buffer.from(
            JSON.stringify([0, "infinity", 0, "99999999999999999999"]),
          ).toString("base64url");
          const current = (await listTasks(owner, { limit: 1 })).eventsCursor;
          const page = await listTasks(owner, { cursor: forged, limit: 1 });
          assert.notEqual(page.eventsCursor, "99999999999999999999:0");
          assert.ok(
            BigInt(page.eventsCursor.split(":")[0]) >=
              BigInt(current.split(":")[0]),
          );
        },
      );
    } finally {
      for (const [key, value] of [
        ["BRAIN_OWNER_EMAIL", saved.owner],
        ["BRAIN_QUERY_EMBEDDINGS", saved.embeddings],
        ["TASKS_ENABLED", saved.tasks],
      ] as const)
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      for (const table of [
        "brain_task_events",
        "brain_task_dependencies",
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
