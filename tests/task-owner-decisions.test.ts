import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTaskSchema, updateTaskSchema } from "../lib/tasks/schemas";
import { createTask, updateTask } from "../lib/tasks/service";
import { saveTaskEdits } from "../lib/workspace/task-moves";
import {
  installServiceDb,
  PAGE_IDS,
  serviceActor,
  type TaskServiceDb,
} from "./helpers/task-service-db";

const input = {
  title: "Review decision",
  idempotencyKey: "owner-decision-atomic",
};
const decisions = PAGE_IDS.slice(0, 2);
const owner = () => serviceActor("owner");
function assertNoWrites(db: TaskServiceDb) {
  assert.deepEqual(db.taskWrites, []);
  assert.deepEqual(db.linkWrites, []);
  assert.deepEqual(db.events, []);
}
function assertDecisions(db: TaskServiceDb, taskId: string) {
  assert.equal(db.links.size, 2);
  assert.deepEqual(
    db.linkWrites.map((row) => row.page_id).sort(),
    [...decisions].sort(),
  );
  assert.ok(
    db.linkWrites.every(
      (row) =>
        row.task_id === taskId &&
        row.role === "decision" &&
        row.origin === "owner" &&
        row.status === "active" &&
        row.created_by_agent_id === db.actor.agentId,
    ),
  );
  const commit = db.queries.lastIndexOf("COMMIT");
  assert.ok(commit >= 0);
  const begin = db.queries.lastIndexOf("BEGIN", commit);
  const validation = db.queries.findIndex(
    (sql, i) =>
      i > begin &&
      sql.includes("FROM brain_pages") &&
      sql.endsWith("FOR SHARE"),
  );
  const firstWrite = db.queries.findIndex(
    (sql, i) => i > begin && /^(INSERT|UPDATE)/.test(sql),
  );
  assert.ok(
    validation > begin && validation < firstWrite,
    "all decision refs validated and locked before writes",
  );
  assert.equal(
    db.queries
      .slice(begin, commit)
      .filter((sql) => sql.startsWith("INSERT INTO brain_task_links")).length,
    1,
  );
}

for (const bad of ["", "  ", "x".repeat(221), 7]) {
  test(`owner decision ref validation rejects ${typeof bad === "string" ? `string length ${bad.length}` : "non-string"} before any write`, async (t) => {
    const db = installServiceDb(t, owner());
    await assert.rejects(createTask(db.actor, input, [bad]), {
      code: "INVALID_INPUT",
    });
    assertNoWrites(db);
    assert.equal(db.tasks.size, 0);
    assert.deepEqual(db.queries, []);
  });
}

test("owner decisions are capped at ten before any write", async (t) => {
  const db = installServiceDb(t, owner());
  await assert.rejects(
    createTask(
      db.actor,
      input,
      Array.from({ length: 11 }, () => PAGE_IDS[0]),
    ),
    { code: "INVALID_INPUT" },
  );
  assertNoWrites(db);
});

for (const mode of ["missing", "foreign owner"] as const) {
  test(`second decision ref ${mode} rejects creation without task links or events`, async (t) => {
    const db = installServiceDb(t, owner());
    if (mode === "missing") db.pages.splice(1, 1);
    else db.pages[1].owner_id = "another-owner";
    await assert.rejects(createTask(db.actor, input, decisions), {
      code: "PAGE_NOT_FOUND",
    });
    assertNoWrites(db);
    assert.equal(db.tasks.size, 0);
    assert.equal(db.links.size, 0);
    assert.deepEqual(db.transactions, ["BEGIN", "ROLLBACK"]);
  });
}

test("owner create writes task and every active decision in exactly one transaction", async (t) => {
  const db = installServiceDb(t, owner());
  const created = await createTask(db.actor, input, decisions);
  assert.equal(db.tasks.size, 1);
  assertDecisions(db, created.task.id);
  assert.deepEqual(db.transactions, ["BEGIN", "COMMIT"]);
});

test("owner create retry replays the same decision payload and conflicts on a changed payload", async (t) => {
  const db = installServiceDb(t, owner());
  const created = await createTask(db.actor, input, decisions);
  const before = [db.taskWrites.length, db.linkWrites.length, db.events.length];
  const replay = await createTask(db.actor, input, [...decisions].reverse());
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.id, created.task.id);
  assert.deepEqual(
    [db.taskWrites.length, db.linkWrites.length, db.events.length],
    before,
  );
  await assert.rejects(createTask(db.actor, input, [PAGE_IDS[2]]), {
    code: "IDEMPOTENCY_KEY_CONFLICT",
  });
  assert.deepEqual(
    [db.taskWrites.length, db.linkWrites.length, db.events.length],
    before,
  );
});

test("missing second decision on edit rejects before content or version changes", async (t) => {
  const db = installServiceDb(t, owner());
  const created = await createTask(db.actor, input);
  db.pages.splice(1, 1);
  const before = structuredClone([...db.tasks]);
  db.taskWrites.length = 0;
  db.linkWrites.length = 0;
  db.events.length = 0;
  await assert.rejects(
    updateTask(
      db.actor,
      {
        ref: created.task.ref,
        expectedVersion: created.task.version,
        patch: { title: "Must not commit" },
      },
      decisions,
    ),
    { code: "PAGE_NOT_FOUND" },
  );
  assert.deepEqual([...db.tasks], before);
  assertNoWrites(db);
});

test("owner edit commits content and all decisions in the same transaction", async (t) => {
  const db = installServiceDb(t, owner());
  const created = await createTask(db.actor, input);
  db.transactions.length = 0;
  const updated = await updateTask(
    db.actor,
    {
      ref: created.task.ref,
      expectedVersion: created.task.version,
      patch: { title: "New title" },
    },
    decisions,
  );
  assert.equal(updated.task.title.value, "New title");
  assert.equal(updated.task.version, created.task.version + 1);
  assertDecisions(db, created.task.id);
  assert.deepEqual(db.transactions, ["BEGIN", "COMMIT"]);
});

test("owner save with only queued decisions accepts an empty patch", async (t) => {
  const db = installServiceDb(t, owner());
  const created = await createTask(db.actor, input);
  db.transactions.length = 0;
  const saved = await saveTaskEdits(
    db.actor,
    created.task.ref,
    created.task.version,
    {},
    undefined,
    decisions,
  );
  assert.equal(saved, created.task.ref);
  assert.equal(db.tasks.size, 1);
  assert.equal(db.taskWrites.length, 1, "no task reinsert or content change");
  assertDecisions(db, created.task.id);
  assert.deepEqual(db.transactions, ["BEGIN", "COMMIT"]);
});

for (const operation of ["create", "update"] as const) {
  test(`decision insert failure rolls back the owner ${operation} and permits a clean retry`, async (t) => {
    const db = installServiceDb(t, owner());
    const existing =
      operation === "update" ? await createTask(db.actor, input) : null;
    const before = structuredClone({
      tasks: [...db.tasks],
      links: [...db.links],
      events: db.events,
    });
    const query = db.query.bind(db);
    let fail = true;
    t.mock.method(db, "query", async (sql: string, params: unknown[] = []) => {
      if (fail && sql.startsWith("INSERT INTO brain_task_links"))
        throw new Error("fake decision insertion failure");
      return query(sql, params);
    });
    await assert.rejects(
      existing
        ? updateTask(
            db.actor,
            {
              ref: existing.task.ref,
              expectedVersion: existing.task.version,
              patch: { title: "Roll back title" },
            },
            decisions,
          )
        : createTask(db.actor, input, decisions),
      /fake decision insertion failure/,
    );
    assert.deepEqual(
      { tasks: [...db.tasks], links: [...db.links], events: db.events },
      before,
    );
    assert.equal(db.transactions.at(-1), "ROLLBACK");
    fail = false;
    const retried = existing
      ? await updateTask(
          db.actor,
          {
            ref: existing.task.ref,
            expectedVersion: existing.task.version,
            patch: { title: "Roll back title" },
          },
          decisions,
        )
      : await createTask(db.actor, input, decisions);
    assert.equal(db.tasks.size, 1);
    assertDecisions(db, retried.task.id);
  });
}

test("archived tasks reject new owner decisions before any write", async (t) => {
  const db = installServiceDb(t, owner());
  const created = await createTask(db.actor, input);
  const row = db.tasks.get(created.task.id);
  assert.ok(row);
  row.archived_at = "2026-11-02T00:00:00Z";
  db.taskWrites.length = 0;
  db.events.length = 0;
  await assert.rejects(
    updateTask(
      db.actor,
      {
        ref: created.task.ref,
        expectedVersion: created.task.version,
        patch: {},
      },
      decisions,
    ),
    { code: "NOT_ALLOWED" },
  );
  assertNoWrites(db);
});

test("decision argument stays owner-only and MCP inputs reject decision fields", async (t) => {
  const db = installServiceDb(t, serviceActor("agent"));
  await assert.rejects(
    createTask(
      db.actor,
      { ...input, origin: "owner_request", ownerQuote: "Track review" },
      decisions,
    ),
    { code: "NOT_ALLOWED" },
  );
  assertNoWrites(db);
  assert.equal(
    createTaskSchema.safeParse({
      ...input,
      origin: "owner_request",
      ownerQuote: "Track review",
      decisionPageRefs: decisions,
    }).success,
    false,
  );
  assert.equal(
    updateTaskSchema.safeParse({
      ref: "T-1",
      expectedVersion: 1,
      patch: { decisionPageRefs: { add: decisions } },
    }).success,
    false,
  );
});

test("owner server actions pass decisions into the service without post-commit link loops", () => {
  const source = readFileSync("app/(workspace)/actions/tasks.ts", "utf8");
  assert.doesNotMatch(source, /linkDecisions|function decisionPageRefs/);
  assert.match(source, /createTask\(actor, input, decisions\)/);
  assert.match(source, /saveTaskEdits\([\s\S]*?delegate,\s*decisions/);
});

test("owner decision argument rejects null and non-array payloads without writes", async (t) => {
  const db = installServiceDb(t, owner());
  for (const invalid of [null, {}, "not-a-list"])
    await assert.rejects(createTask(db.actor, input, invalid), {
      code: "INVALID_INPUT",
    });
  assertNoWrites(db);
  assert.deepEqual(db.queries, []);
});
