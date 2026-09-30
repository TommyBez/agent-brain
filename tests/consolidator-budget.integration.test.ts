import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getPool } from "../lib/db";
import {
  BudgetExhaustedError,
  budgetedGateway,
  reserveSpend,
} from "../lib/maintenance/consolidator/budget";

const database = process.env.BRAIN_TEST_DATABASE_URL;
test(
  "daily spend reservations are atomic across owners and runs and survive unknown outcomes",
  { skip: !database },
  async (t) => {
    assert.ok(database);
    const schema = `budget_${randomUUID().replaceAll("-", "")}`;
    const { Pool } = await import("pg");
    const setup = new Pool({ connectionString: database });
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.query(
      `CREATE TABLE ${schema}.brain_consolidation_spend (LIKE public.brain_consolidation_spend INCLUDING ALL)`,
    );
    const isolated = new URL(database);
    isolated.searchParams.set("options", `-c search_path=${schema},public`);
    process.env.DATABASE_URL = isolated.toString();
    const owner = `budget-test-${randomUUID()}`;
    const other = `${owner}-other`;
    const pool = getPool();
    const previousKey = process.env.AI_GATEWAY_API_KEY;
    process.env.AI_GATEWAY_API_KEY = "test-only";
    t.after(async () => {
      await pool.query(
        "DELETE FROM brain_consolidation_spend WHERE owner_id=ANY($1::text[])",
        [[owner, other]],
      );
      if (previousKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = previousKey;
      await pool.end();
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.end();
    });
    const calls = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        reserveSpend(
          i % 2 ? owner : other,
          `run-${i}`,
          "typesafe-ai/jev",
          100_000_000,
        ),
      ),
    );
    assert.equal(
      calls.filter((call) => call.status === "fulfilled").length,
      10,
    );
    assert.ok(
      calls
        .filter((call) => call.status === "rejected")
        .every((call) => call.reason instanceof BudgetExhaustedError),
    );
    const total = await pool.query(
      "SELECT sum(reserved_nano)::text AS total FROM brain_consolidation_spend WHERE owner_id=ANY($1::text[])",
      [[owner, other]],
    );
    assert.equal(total.rows[0].total, "1000000000");
    await pool.query(
      "DELETE FROM brain_consolidation_spend WHERE owner_id=ANY($1::text[])",
      [[owner, other]],
    );

    const fetch = t.mock.method(globalThis, "fetch", async () => {
      throw new Error("Unknown provider outcome");
    });
    const send = budgetedGateway(owner, "retry-run");
    for (let i = 0; i < 2; i++)
      await assert.rejects(
        send("evaluate", {
          model: "typesafe-ai/jev",
          state: "A fact",
          questions: {},
        }),
      );
    const unknown = await pool.query(
      "SELECT reserved_nano,actual_nano FROM brain_consolidation_spend WHERE owner_id=$1",
      [owner],
    );
    assert.equal(unknown.rowCount, 2);
    assert.ok(
      unknown.rows.every(
        (row) => Number(row.reserved_nano) > 0 && row.actual_nano === null,
      ),
    );

    fetch.mock.mockImplementation(async () =>
      Response.json({ providerMetadata: { gateway: { cost: "0.000042" } } }),
    );
    await send("evaluate", {
      model: "typesafe-ai/jev",
      state: "Another fact",
      questions: {},
    });
    const actual = await pool.query(
      "SELECT actual_nano FROM brain_consolidation_spend WHERE owner_id=$1 AND actual_nano IS NOT NULL",
      [owner],
    );
    assert.equal(actual.rows[0].actual_nano, "42000");
  },
);
