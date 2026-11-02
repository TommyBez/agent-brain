import assert from "node:assert/strict";
import test from "node:test";
import {
  COUNT_SQL,
  RETRACT_SQL,
  retractSuggestedTaskLinks,
} from "../scripts/retract-suggested-task-links";

function fake() {
  const rows = [
    { status: "suggested", decided: false },
    { status: "suggested", decided: false },
    { status: "active", decided: true },
    { status: "rejected", decided: true },
  ];
  const calls: string[] = [];
  return {
    rows,
    calls,
    async query(sql: string) {
      calls.push(sql);
      const pending = rows.filter(
        (row) => row.status === "suggested" && !row.decided,
      );
      if (sql === COUNT_SQL)
        return { rows: [{ count: String(pending.length) }], rowCount: 1 };
      assert.equal(sql, RETRACT_SQL);
      for (const row of pending) row.status = "retracted";
      return { rows: [], rowCount: pending.length };
    },
  };
}

test("dry-run only counts and leaves all rows unchanged", async () => {
  const db = fake();
  assert.deepEqual(await retractSuggestedTaskLinks(db), {
    count: 2,
    changed: 0,
  });
  assert.deepEqual(db.calls, [COUNT_SQL]);
  assert.equal(db.rows.filter((row) => row.status === "suggested").length, 2);
});

test("apply retracts unconfirmed suggestions and is idempotent", async () => {
  const db = fake();
  assert.deepEqual(await retractSuggestedTaskLinks(db, true), {
    count: 2,
    changed: 2,
  });
  assert.equal(db.rows.filter((row) => row.status === "suggested").length, 0);
  assert.deepEqual(await retractSuggestedTaskLinks(db, true), {
    count: 0,
    changed: 0,
  });
  assert.deepEqual(
    db.rows.map((row) => row.status),
    ["retracted", "retracted", "active", "rejected"],
  );
  assert.match(
    RETRACT_SQL,
    /^UPDATE brain_task_links SET status = 'retracted', updated_at = now\(\) WHERE status = 'suggested' AND decided_at IS NULL AND decided_by_agent_id IS NULL$/,
  );
  assert.doesNotMatch(RETRACT_SQL, /\b(CREATE|ALTER|DROP|INSERT|DELETE)\b/i);
});
