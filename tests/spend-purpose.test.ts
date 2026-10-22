import assert from "node:assert/strict";
import test from "node:test";
import {
  BudgetExhaustedError,
  purposeBudgetNano,
  SPEND_SHARE_TENTHS,
  spendPurposeGroup,
  TASK_SPEND_PURPOSES,
} from "../lib/maintenance/consolidator/budget";
import { SPEND_PURPOSES, TASK_JOB_KINDS } from "../lib/tasks/types";

test("pages keep 90% and the task phases share 10% of the pooled cap", () => {
  assert.deepEqual(SPEND_SHARE_TENTHS, { pages: 9, tasks: 1 });
  assert.equal(purposeBudgetNano("pages", 1, true), 900_000_000);
  assert.equal(purposeBudgetNano("task_keeper", 1, true), 100_000_000);
  assert.equal(purposeBudgetNano("task_links", 1, true), 100_000_000);
  assert.equal(purposeBudgetNano("pages", 3, true), 2_700_000_000);
  assert.equal(purposeBudgetNano("task_links", 3, true), 300_000_000);
  assert.equal(purposeBudgetNano("pages", 0, true), 0);
  assert.equal(purposeBudgetNano("task_keeper", 0, true), 0);
});

test("without the task release pages keep the whole pooled cap", () => {
  assert.equal(purposeBudgetNano("pages", 1, false), 1_000_000_000);
  assert.equal(purposeBudgetNano("pages", 2, false), 2_000_000_000);
  const previous = process.env.TASKS_ENABLED;
  try {
    delete process.env.TASKS_ENABLED;
    assert.equal(purposeBudgetNano("pages", 1), 1_000_000_000);
    process.env.TASKS_ENABLED = "true";
    assert.equal(purposeBudgetNano("pages", 1), 900_000_000);
  } finally {
    if (previous === undefined) delete process.env.TASKS_ENABLED;
    else process.env.TASKS_ENABLED = previous;
  }
});

test("page sums exclude the task phases, which count together", () => {
  assert.deepEqual(spendPurposeGroup("pages"), ["pages"]);
  assert.deepEqual(spendPurposeGroup("task_keeper"), TASK_SPEND_PURPOSES);
  assert.deepEqual(spendPurposeGroup("task_links"), TASK_SPEND_PURPOSES);
  assert.deepEqual(TASK_SPEND_PURPOSES, TASK_JOB_KINDS);
  assert.deepEqual(
    [...new Set([...spendPurposeGroup("pages"), ...TASK_SPEND_PURPOSES])],
    SPEND_PURPOSES,
  );
});

test("budget errors name their purpose and keep the page message", () => {
  assert.equal(new BudgetExhaustedError().purpose, "pages");
  assert.equal(
    new BudgetExhaustedError().message,
    "Daily consolidation budget exhausted",
  );
  assert.equal(new BudgetExhaustedError("task_links").purpose, "task_links");
  assert.match(new BudgetExhaustedError("task_keeper").message, /task/);
});
