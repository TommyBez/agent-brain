import assert from "node:assert/strict";
import test from "node:test";
import {
  COUNT_SQL,
  RETRACT_SQL,
  retractSuggestedTaskLinks,
} from "../scripts/retract-suggested-task-links";

function fake() {
  const rows = [
    { status: "suggested", origin: "rule", role: "context", decided: false },
    {
      status: "suggested",
      origin: "consolidator",
      role: "decision",
      decided: false,
    },
    {
      status: "suggested",
      origin: "provenance",
      role: "produced",
      decided: false,
    },
    { status: "suggested", origin: "rule", role: "produced", decided: false },
    { status: "suggested", origin: "owner", role: "context", decided: false },
    { status: "suggested", origin: "rule", role: "context", decided: true },
    { status: "active", origin: "rule", role: "context", decided: false },
    {
      status: "rejected",
      origin: "consolidator",
      role: "context",
      decided: true,
    },
  ];
  const calls: string[] = [];
  return {
    rows,
    calls,
    async query(sql: string) {
      calls.push(sql);
      const pending = rows.filter(
        (r) =>
          r.status === "suggested" &&
          ["rule", "consolidator"].includes(r.origin) &&
          r.role !== "produced" &&
          !r.decided,
      );
      if (sql === COUNT_SQL)
        return { rows: [{ count: String(pending.length) }], rowCount: 1 };
      assert.equal(sql, RETRACT_SQL);
      for (const row of pending) row.status = "retracted";
      return { rows: [], rowCount: pending.length };
    },
  };
}
test("dry-run counts only undecided automatic suggestions without modifying data", async () => {
  const db = fake();
  const before = structuredClone(db.rows);
  assert.deepEqual(await retractSuggestedTaskLinks(db), {
    count: 2,
    changed: 0,
  });
  assert.deepEqual(db.rows, before);
  assert.deepEqual(db.calls, [COUNT_SQL]);
});
test("atomic retract preserves produced provenance owner and confirmed suggestions and is idempotent", async () => {
  const db = fake();
  const protectedRows = structuredClone(db.rows.slice(2));
  assert.deepEqual(await retractSuggestedTaskLinks(db, true), {
    count: 2,
    changed: 2,
  });
  assert.deepEqual(
    db.calls,
    [RETRACT_SQL],
    "apply reports only the atomic update count",
  );
  assert.deepEqual(db.rows.slice(2), protectedRows);
  assert.deepEqual(await retractSuggestedTaskLinks(db, true), {
    count: 0,
    changed: 0,
  });
  assert.ok(db.rows.slice(0, 2).every((row) => row.status === "retracted"));
  assert.match(
    RETRACT_SQL,
    /origin IN \('rule', 'consolidator'\) AND role <> 'produced'/,
  );
  assert.match(
    RETRACT_SQL,
    /decided_at IS NULL AND decided_by_agent_id IS NULL RETURNING page_id$/,
  );
  assert.doesNotMatch(RETRACT_SQL, /\b(CREATE|ALTER|DROP|INSERT|DELETE)\b/i);
});
