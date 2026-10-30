import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getPool } from "../lib/db";
import {
  BudgetExhaustedError,
  budgetedGateway,
  recordedSpendNano,
  startSpend,
} from "../lib/maintenance/consolidator/budget";
import type { SpendPurpose } from "../lib/tasks/types";

const database = process.env.BRAIN_TEST_DATABASE_URL;
const JEV = "typesafe-ai/jev-1.14.0";

test(
  "soft caps separate page and task spending inside the pooled daily cap",
  { skip: !database },
  async (t) => {
    assert.ok(database);
    const schema = `spend_${randomUUID().replaceAll("-", "")}`;
    const { Pool } = await import("pg");
    const setup = new Pool({ connectionString: database });
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.query(
      `CREATE TABLE ${schema}.brain_consolidation_spend (LIKE public.brain_consolidation_spend INCLUDING ALL)`,
    );
    await setup.query(
      `CREATE TABLE ${schema}."user" (id text PRIMARY KEY, email text NOT NULL)`,
    );
    await setup.query(
      `CREATE TABLE ${schema}.brain_task_settings (LIKE public.brain_task_settings INCLUDING ALL)`,
    );
    const isolated = new URL(database);
    isolated.searchParams.set("options", `-c search_path=${schema},public`);
    process.env.DATABASE_URL = isolated.toString();
    const owner = `spend-test-${randomUUID()}`;
    const other = `${owner}-other`;
    const email = `${owner}@example.invalid`;
    const otherEmail = `${other}@example.invalid`;
    const saved = {
      key: process.env.AI_GATEWAY_API_KEY,
      owner: process.env.BRAIN_OWNER_EMAIL,
    };
    process.env.AI_GATEWAY_API_KEY = "test-only";
    process.env.BRAIN_OWNER_EMAIL = email;
    const pool = getPool();
    await pool.query(`INSERT INTO "user" (id, email) VALUES ($1, $2)`, [
      owner,
      email,
    ]);
    // Each account's own task manager setting sizes the task share.
    const setTasks = (id: string, enabled: boolean) =>
      pool.query(
        `INSERT INTO brain_task_settings (owner_id, enabled) VALUES ($1, $2)
         ON CONFLICT (owner_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
        [id, enabled],
      );
    await setTasks(owner, true);
    t.after(async () => {
      for (const [name, value] of [
        ["AI_GATEWAY_API_KEY", saved.key],
        ["BRAIN_OWNER_EMAIL", saved.owner],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await pool.end();
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.end();
    });
    async function spent(purpose: SpendPurpose, nano: number, who = other) {
      const id = await startSpend(who, `prior-${purpose}`, JEV, purpose);
      await pool.query(
        "UPDATE brain_consolidation_spend SET actual_nano=$2 WHERE id=$1",
        [id, nano],
      );
      return id;
    }
    const blocked = (purpose: SpendPurpose) => (error: unknown) =>
      error instanceof BudgetExhaustedError && error.purpose === purpose;
    const reset = () => pool.query("DELETE FROM brain_consolidation_spend");

    await t.test("rows record their purpose, pages by default", async () => {
      const pages = await startSpend(owner, "run", JEV);
      const links = await startSpend(owner, "run", JEV, "task_links");
      const { rows } = await pool.query<{ id: string; purpose: string }>(
        "SELECT id, purpose FROM brain_consolidation_spend",
      );
      assert.deepEqual(
        new Map(rows.map((row) => [row.id, row.purpose])),
        new Map([
          [pages, "pages"],
          [links, "task_links"],
        ]),
      );
      await assert.rejects(
        startSpend(owner, "run", JEV, "harvest" as SpendPurpose),
        /Unknown spending purpose/,
      );
      await reset();
    });

    await t.test(
      "pages stop at 90% of the cap and their sum ignores task spending",
      async () => {
        await spent("pages", 899_999_999);
        await spent("task_keeper", 99_999_999);
        assert.ok(await startSpend(owner, "pages-run", JEV));
        await spent("pages", 1);
        await assert.rejects(
          startSpend(owner, "pages-run", JEV),
          blocked("pages"),
        );
        // The task quota is still open although pages exhausted theirs.
        assert.ok(await startSpend(owner, "links-run", JEV, "task_links"));
        await reset();
      },
    );

    await t.test(
      "task_keeper and task_links share 10% and ignore page spending",
      async () => {
        await spent("pages", 899_999_999);
        await spent("task_keeper", 60_000_000);
        await spent("task_links", 39_999_999);
        assert.ok(await startSpend(owner, "keeper-run", JEV, "task_keeper"));
        await spent("task_links", 1);
        for (const purpose of ["task_keeper", "task_links"] as const)
          await assert.rejects(
            startSpend(owner, `${purpose}-run`, JEV, purpose),
            blocked(purpose),
          );
        assert.ok(await startSpend(owner, "pages-run", JEV));
        await reset();
      },
    );

    await t.test(
      "the pooled cap still binds when a task phase overshoots its share",
      async () => {
        // Completed calls may overshoot; pages stop at the pooled cap below 90%.
        await spent("task_keeper", 150_000_000);
        await spent("pages", 850_000_000);
        await assert.rejects(
          startSpend(owner, "pages-run", JEV),
          blocked("pages"),
        );
        await reset();
      },
    );

    await t.test(
      "with no task manager on pages keep the whole cap and task phases get none",
      async () => {
        for (const off of [
          () => setTasks(owner, false),
          // Without any setting row the task manager is off as well.
          () => pool.query("DELETE FROM brain_task_settings"),
        ]) {
          await off();
          await assert.rejects(
            startSpend(owner, "keeper-run", JEV, "task_keeper"),
            blocked("task_keeper"),
          );
          await spent("pages", 999_999_999);
          assert.ok(await startSpend(owner, "pages-run", JEV));
          await spent("pages", 1);
          await assert.rejects(
            startSpend(owner, "pages-run", JEV),
            blocked("pages"),
          );
          await reset();
        }
        // Turned back on, pages are held to 90% again.
        await setTasks(owner, true);
        await spent("pages", 950_000_000);
        await assert.rejects(
          startSpend(owner, "pages-run", JEV),
          blocked("pages"),
        );
        await reset();
      },
    );

    await t.test(
      "with some accounts on, only their tenths move to the task phases",
      async () => {
        // Two allowlisted accounts pool $2; only the owner's tasks are on, so
        // the task phases get $0.10 and pages $1.90.
        process.env.BRAIN_OWNER_EMAIL = `${email},${otherEmail}`;
        await pool.query(`INSERT INTO "user" (id, email) VALUES ($1, $2)`, [
          other,
          otherEmail,
        ]);
        await setTasks(other, false);
        try {
          await spent("task_keeper", 99_999_999);
          assert.ok(await startSpend(owner, "links-run", JEV, "task_links"));
          await spent("task_links", 1);
          await assert.rejects(
            startSpend(owner, "keeper-run", JEV, "task_keeper"),
            blocked("task_keeper"),
          );
          await reset();
          await spent("pages", 1_899_999_999);
          assert.ok(await startSpend(other, "pages-run", JEV));
          await spent("pages", 1);
          await assert.rejects(
            startSpend(other, "pages-run", JEV),
            blocked("pages"),
          );
          assert.ok(await startSpend(owner, "keeper-run", JEV, "task_keeper"));

          // The other account turns its task manager on: $0.20 and $1.80.
          await setTasks(other, true);
          await reset();
          await spent("task_keeper", 199_999_999);
          assert.ok(await startSpend(owner, "links-run", JEV, "task_links"));
          await spent("task_links", 1);
          await assert.rejects(
            startSpend(owner, "keeper-run", JEV, "task_keeper"),
            blocked("task_keeper"),
          );
          await reset();
          await spent("pages", 1_799_999_999);
          assert.ok(await startSpend(other, "pages-run", JEV));
          await spent("pages", 1);
          await assert.rejects(
            startSpend(other, "pages-run", JEV),
            blocked("pages"),
          );
          await reset();

          // A setting outside the allowlist counts for nothing.
          process.env.BRAIN_OWNER_EMAIL = email;
          await spent("task_keeper", 100_000_000);
          await assert.rejects(
            startSpend(owner, "keeper-run", JEV, "task_keeper"),
            blocked("task_keeper"),
          );
        } finally {
          process.env.BRAIN_OWNER_EMAIL = email;
          await pool.query(`DELETE FROM "user" WHERE id = $1`, [other]);
          await pool.query(
            "DELETE FROM brain_task_settings WHERE owner_id = $1",
            [other],
          );
          await reset();
        }
      },
    );

    await t.test(
      "a purpose-bound gateway charges its calls and reports this run's cost",
      async () => {
        const fetch = t.mock.method(globalThis, "fetch", async () =>
          Response.json({ providerMetadata: { gateway: { cost: "0.0003" } } }),
        );
        const send = budgetedGateway(owner, "night", "task_links");
        await send("evaluate", { model: JEV, state: "A task", questions: {} });
        await send("evaluate", { model: JEV, state: "A task", questions: {} });
        await budgetedGateway(owner, "night")("evaluate", {
          model: JEV,
          state: "A page",
          questions: {},
        });
        assert.equal(fetch.mock.callCount(), 3);
        assert.equal(
          await recordedSpendNano(owner, "night", ["task_links"]),
          600_000,
        );
        assert.equal(
          await recordedSpendNano(owner, "night", ["pages"]),
          300_000,
        );
        assert.equal(
          await recordedSpendNano(owner, "night", ["task_keeper"]),
          0,
        );
        assert.equal(
          await recordedSpendNano(other, "night", ["task_links"]),
          0,
        );
        await spent("task_keeper", 100_000_000);
        await assert.rejects(
          send("evaluate", { model: JEV, state: "A task", questions: {} }),
          blocked("task_links"),
        );
        assert.equal(fetch.mock.callCount(), 3);
        await reset();
      },
    );
  },
);
