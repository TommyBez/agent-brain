import assert from "node:assert/strict";
import test from "node:test";
import { createTask, updateTask } from "../lib/tasks/service";
import {
  installServiceDb,
  PAGE_IDS,
  serviceActor,
  type TaskServiceDb,
} from "./helpers/task-service-db";

function assertLinks(
  db: TaskServiceDb,
  pages: string[],
  origin: "owner" | "agent",
) {
  assert.equal(db.linkWrites.length, pages.length, "exact link write count");
  assert.equal(db.links.size, pages.length, "exact persisted link count");
  assert.deepEqual(
    db.linkWrites.map((row) => row.page_id).sort(),
    [...pages].sort(),
  );
  assert.ok(
    db.linkWrites.every(
      (row) =>
        row.status === "active" &&
        row.origin === origin &&
        row.role === "context" &&
        row.created_by_agent_id === db.actor.agentId,
    ),
  );
}

for (const kind of ["owner", "agent"] as const) {
  const input = {
    title: "Review report",
    description: "A task with no page mentions.",
    ...(kind === "agent"
      ? {
          origin: "owner_request",
          idempotencyKey: "service-links-test",
          ownerQuote: "Track the report review",
        }
      : {}),
  };

  test(`createTask without context pages or mentions writes one task and zero links (${kind})`, async (t) => {
    const db = installServiceDb(t, serviceActor(kind));
    const result = await createTask(db.actor, input);
    assert.equal(db.tasks.size, 1);
    assert.equal(db.taskWrites.length, 1);
    assert.equal(db.taskWrites[0].operation, "insert");
    assert.equal(db.tasks.get(result.task.id)?.title, input.title);
    assertLinks(db, [], kind);
  });

  for (const [field, value, column] of [
    ["title", "Revised report review", "title"],
    [
      "description",
      "Updated description without page mentions.",
      "description",
    ],
    ["status", "canceled", "status"],
  ] as const) {
    test(`updateTask ${field} persists the change and writes zero new links (${kind})`, async (t) => {
      const db = installServiceDb(t, serviceActor(kind));
      const created = await createTask(db.actor, input);
      assertLinks(db, [], kind);
      const result = await updateTask(db.actor, {
        ref: created.task.ref,
        expectedVersion: created.task.version,
        patch: { [field]: value },
      });
      assert.equal(db.tasks.size, 1, "update must not create another task");
      assert.deepEqual(
        db.taskWrites.map((write) => write.operation),
        ["insert", "update"],
      );
      assert.equal(db.tasks.get(created.task.id)?.[column], value);
      assert.equal(
        db.tasks.get(created.task.id)?.version,
        created.task.version + 1,
      );
      assert.ok(result.changedFields.includes(field));
      assertLinks(db, [], kind);
    });
  }

  test(`createTask with two context pages writes exactly two active actor-origin links (${kind})`, async (t) => {
    const db = installServiceDb(t, serviceActor(kind));
    const pages = PAGE_IDS.slice(0, 2);
    const result = await createTask(db.actor, {
      ...input,
      contextPageRefs: pages,
    });
    assert.equal(db.tasks.size, 1);
    assert.equal(db.taskWrites.length, 1);
    assert.equal(result.linked.length, 2);
    assertLinks(db, pages, kind);
  });

  test(`updateTask adding two context pages writes exactly two new active actor-origin links (${kind})`, async (t) => {
    const db = installServiceDb(t, serviceActor(kind));
    const created = await createTask(db.actor, {
      ...input,
      contextPageRefs: PAGE_IDS.slice(0, 2),
    });
    assertLinks(db, PAGE_IDS.slice(0, 2), kind);
    const before = db.linkWrites.length;
    const pages = PAGE_IDS.slice(2, 4);
    await updateTask(db.actor, {
      ref: created.task.ref,
      expectedVersion: created.task.version,
      patch: { contextPageRefs: { add: pages } },
    });
    assert.equal(db.tasks.size, 1);
    assert.equal(
      db.taskWrites.length,
      1,
      "context update must not insert or redefine the task",
    );
    assert.equal(db.linkWrites.length - before, 2);
    assert.deepEqual(
      db.linkWrites
        .slice(before)
        .map((row) => row.page_id)
        .sort(),
      [...pages].sort(),
    );
    assertLinks(db, PAGE_IDS, kind);
  });
}

test("createTask rejects a system actor without any task or link writes", async (t) => {
  const db = installServiceDb(t, serviceActor("system"));
  await assert.rejects(createTask(db.actor, { title: "Automatic task" }), {
    code: "NOT_ALLOWED",
  });
  assert.equal(db.tasks.size, 0);
  assert.deepEqual(db.taskWrites, []);
  assert.deepEqual(db.linkWrites, []);
  assert.equal(db.links.size, 0);
  assert.deepEqual(db.events, []);
  assert.deepEqual(db.queries, []);
});
