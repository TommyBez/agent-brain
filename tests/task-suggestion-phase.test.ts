import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { GatewayCall } from "../lib/maintenance/gateway";
import {
  suggestTaskLinks,
  type TaskLinkSuggestionResult,
} from "../lib/tasks/link-candidates";
import { SUGGESTION_POLICY } from "../lib/tasks/suggestion-control";
import {
  installServiceDb,
  PAGE_IDS,
  serviceActor,
} from "./helpers/task-service-db";

const projects = PAGE_IDS.slice(0, 2).map((id, index) => ({
  id,
  slug: `project/launch-${index}`,
  title: `Launch ${index}`,
  markdown: "Launch scope",
  type: "project",
}));
const never = () => new Promise<never>(() => {});

function fakeReads(
  t: TestContext,
  stall: (sql: string) => boolean = () => false,
  taskProject: string | null = null,
) {
  const db = installServiceDb(t, serviceActor("owner"));
  const queries: string[] = [];
  t.mock.method(db, "query", async (sql: string) => {
    queries.push(sql);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|MERGE|CALL)\b/i);
    if (stall(sql)) return never();
    if (sql.includes("FROM brain_consolidation_spend"))
      return { rows: [{ spent_nano: "0", accounts: 1 }], rowCount: 1 };
    if (sql.includes("WITH lexical_candidates"))
      return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT p.id")) return { rows: projects, rowCount: 2 };
    if (sql.startsWith("SELECT id, slug, title, type"))
      return { rows: [projects[0]], rowCount: 1 };
    if (sql.startsWith("SELECT t.id"))
      return {
        rows: [
          {
            title: "Launch",
            description: "Review scope",
            project_page_id: taskProject,
          },
        ],
        rowCount: 1,
      };
    throw new Error("Unexpected read query");
  });
  t.after(() => {
    assert.ok(queries.length > 0);
    assert.deepEqual(db.taskWrites, []);
    assert.deepEqual(db.linkWrites, []);
    assert.deepEqual(db.events, []);
  });
  return db;
}

async function expire(
  t: TestContext,
  work: () => Promise<TaskLinkSuggestionResult>,
) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = work();
  // Flush fake reads and evaluation scheduling; only the deadline clock is mocked.
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(SUGGESTION_POLICY.deadlineMs);
  return result;
}

function projectDeadline(result: TaskLinkSuggestionResult, ids: string[]) {
  assert.equal(result.kind, "project");
  if (result.kind !== "project") throw new Error("Expected project phase");
  assert.deepEqual(result.candidates, []);
  assert.equal(result.status, "deterministic");
  assert.equal(result.fallbackReason, "deadline");
  assert.equal(result.projectProposal.status, "deterministic");
  assert.equal(result.projectProposal.fallbackReason, "deadline");
  assert.equal(result.projectProposal.preselectedProjectRef, null);
  assert.deepEqual(
    result.projectProposal.candidates.map((p) => p.projectRef),
    ids,
  );
  assert.ok(result.projectProposal.candidates.every((p) => p.score === null));
}

test('project phase: JEV send that never resolves past the deadline returns kind "project" with deterministic candidates, never empty pages', async (t) => {
  const db = fakeReads(t);
  let sends = 0;
  const send: GatewayCall = async () => {
    sends++;
    return never();
  };
  const result = await expire(t, () =>
    suggestTaskLinks(db.actor, { title: "Launch" }, send),
  );
  assert.equal(sends, 1);
  projectDeadline(
    result,
    projects.map((p) => p.id),
  );
});

test('project phase: deadline before deterministic project reads finish returns kind "project" (empty candidates), not pages', async (t) => {
  const db = fakeReads(t, (sql) => sql.startsWith("SELECT p.id"));
  const result = await expire(t, () =>
    suggestTaskLinks(db.actor, { title: "Launch" }, async () =>
      assert.fail("No evaluation before reads finish"),
    ),
  );
  projectDeadline(result, []);
});

test("project phase: deadline retains candidates from completed sources while another source is pending", async (t) => {
  const db = fakeReads(t, (sql) => sql.includes("JOIN brain_tasks t"));
  const result = await expire(t, () =>
    suggestTaskLinks(
      { ownerId: db.actor.ownerId },
      { title: "Launch" },
      async () => assert.fail("No evaluation before all sources finish"),
    ),
  );
  projectDeadline(
    result,
    projects.map((p) => p.id),
  );
});

test("project phase: deadline before budget or lexical reads finish already has the project fallback", async (t) => {
  const db = fakeReads(t, (sql) =>
    sql.includes("FROM brain_consolidation_spend"),
  );
  const result = await expire(t, () =>
    suggestTaskLinks(db.actor, { title: "Launch" }, async () =>
      assert.fail("No evaluation before budget read"),
    ),
  );
  projectDeadline(result, []);
});

test('unknown phase: deadline while a ref task loads conservatively returns kind "project" for retry', async (t) => {
  const db = fakeReads(t, (sql) => sql.startsWith("SELECT t.id"));
  const result = await expire(t, () =>
    suggestTaskLinks(db.actor, { ref: "T-1" }, async () =>
      assert.fail("No evaluation before task loads"),
    ),
  );
  projectDeadline(result, []);
});

test('project phase: a ref task loaded without a project stays kind "project" when a later read exceeds the deadline', async (t) => {
  let budgetRead = false;
  const db = fakeReads(t, (sql) => {
    if (!sql.includes("FROM brain_consolidation_spend")) return false;
    budgetRead = true;
    return true;
  });
  const result = await expire(t, () =>
    suggestTaskLinks(db.actor, { ref: "T-1" }, async () =>
      assert.fail("No evaluation before budget read finishes"),
    ),
  );
  assert.equal(budgetRead, true, "the task row loaded before the stalled read");
  projectDeadline(result, []);
});

test('pages phase: ref plus projectRef returns kind "pages" deterministic when the deadline fires before the task row loads', async (t) => {
  let taskRead = false;
  const db = fakeReads(t, (sql) => {
    assert.ok(
      sql.startsWith("SELECT t.id"),
      "no reads after the pending task row",
    );
    taskRead = true;
    return true;
  });
  const result = await expire(t, () =>
    suggestTaskLinks(
      db.actor,
      { ref: "T-1", projectRef: projects[0].id },
      async () => assert.fail("No evaluation before task loads"),
    ),
  );
  assert.equal(taskRead, true);
  assert.equal(result.kind, "pages");
  assert.deepEqual(result.candidates, []);
  assert.equal(result.status, "deterministic");
  assert.equal(result.fallbackReason, "deadline");
  assert.equal(result.projectProposal, undefined);
});

test('pages phase: a loaded ref with a project registers kind "pages" before the next read', async (t) => {
  const db = fakeReads(
    t,
    (sql) => sql.includes("FROM brain_consolidation_spend"),
    projects[0].id,
  );
  const result = await expire(t, () =>
    suggestTaskLinks(db.actor, { ref: "T-1" }, async () =>
      assert.fail("No evaluation before budget read"),
    ),
  );
  assert.equal(result.kind, "pages");
  assert.equal(result.fallbackReason, "deadline");
  assert.equal(result.projectProposal, undefined);
});

test('pages phase (draft with project): deadline returns kind "pages" deterministic', async (t) => {
  const db = fakeReads(t, (sql) =>
    sql.startsWith("SELECT id, slug, title, type"),
  );
  const result = await expire(t, () =>
    suggestTaskLinks(
      db.actor,
      { title: "Launch", projectRef: projects[0].id },
      async () => assert.fail("No evaluation before project resolves"),
    ),
  );
  assert.equal(result.kind, "pages");
  assert.deepEqual(result.candidates, []);
  assert.equal(result.status, "deterministic");
  assert.equal(result.fallbackReason, "deadline");
  assert.equal(result.projectProposal, undefined);
});

for (const failure of ["gateway failure", "malformed JEV answer"] as const) {
  test(`project phase: ${failure} returns kind "project" with deterministic candidates`, async (t) => {
    const db = fakeReads(t);
    let sends = 0;
    const send = (async () => {
      sends++;
      if (failure === "gateway failure") throw new Error("fake unavailable");
      return { answers: "invalid" };
    }) as GatewayCall;
    const result = await suggestTaskLinks(db.actor, { title: "Launch" }, send);
    assert.equal(sends, 1);
    assert.equal(result.kind, "project");
    if (result.kind !== "project") throw new Error("Expected project phase");
    assert.deepEqual(result.candidates, []);
    assert.equal(result.status, "deterministic");
    assert.equal(result.fallbackReason, "gateway");
    assert.equal(result.projectProposal.status, "deterministic");
    assert.equal(result.projectProposal.fallbackReason, "gateway");
    assert.equal(result.projectProposal.preselectedProjectRef, null);
    assert.deepEqual(
      result.projectProposal.candidates.map((p) => p.projectRef),
      projects.map((p) => p.id),
    );
  });
}
