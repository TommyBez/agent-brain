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
    await setup.query(`CREATE TABLE ${schema}."user" (email text PRIMARY KEY)`);
    const isolated = new URL(database);
    isolated.searchParams.set("options", `-c search_path=${schema},public`);
    process.env.DATABASE_URL = isolated.toString();
    const owner = `spend-test-${randomUUID()}`;
    const other = `${owner}-other`;
    const email = `${owner}@example.invalid`;
    const saved = {
      key: process.env.AI_GATEWAY_API_KEY,
      owner: process.env.BRAIN_OWNER_EMAIL,
      tasks: process.env.TASKS_ENABLED,
    };
    process.env.AI_GATEWAY_API_KEY = "test-only";
    process.env.BRAIN_OWNER_EMAIL = email;
    process.env.TASKS_ENABLED = "true";
    const pool = getPool();
    await pool.query(`INSERT INTO "user" (email) VALUES ($1)`, [email]);
    t.after(async () => {
      for (const [name, value] of [
        ["AI_GATEWAY_API_KEY", saved.key],
        ["BRAIN_OWNER_EMAIL", saved.owner],
        ["TASKS_ENABLED", saved.tasks],
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
      "the pooled cap still binds, and pages keep it all without the release",
      async () => {
        process.env.TASKS_ENABLED = "false";
        await spent("pages", 950_000_000);
        assert.ok(await startSpend(owner, "pages-run", JEV));
        await spent("task_links", 50_000_000);
        await assert.rejects(
          startSpend(owner, "pages-run", JEV),
          blocked("pages"),
        );
        await assert.rejects(
          startSpend(owner, "links-run", JEV, "task_links"),
          blocked("task_links"),
        );
        process.env.TASKS_ENABLED = "true";
        await reset();
        await spent("pages", 950_000_000);
        await assert.rejects(
          startSpend(owner, "pages-run", JEV),
          blocked("pages"),
        );
        await reset();
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
