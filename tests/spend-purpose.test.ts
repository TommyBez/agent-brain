import assert from "node:assert/strict";
import test from "node:test";
import {
  BudgetExhaustedError,
  dailyBudgetNano,
  purposeBudgetNano,
  SPEND_SHARE_TENTHS,
  spendPurposeGroup,
  TASK_SPEND_PURPOSES,
} from "../lib/maintenance/consolidator/budget";
import { SPEND_PURPOSES, TASK_JOB_KINDS } from "../lib/tasks/types";

test("with every account's task manager on pages keep 90% and the task phases share 10%", () => {
  assert.deepEqual(SPEND_SHARE_TENTHS, { pages: 9, tasks: 1 });
  assert.equal(purposeBudgetNano("pages", 1, 1), 900_000_000);
  assert.equal(purposeBudgetNano("task_keeper", 1, 1), 100_000_000);
  assert.equal(purposeBudgetNano("task_links", 1, 1), 100_000_000);
  assert.equal(purposeBudgetNano("pages", 3, 3), 2_700_000_000);
  assert.equal(purposeBudgetNano("task_links", 3, 3), 300_000_000);
  assert.equal(purposeBudgetNano("pages", 0, 0), 0);
  assert.equal(purposeBudgetNano("task_keeper", 0, 0), 0);
});

test("with no account's task manager on pages keep the whole pooled cap", () => {
  assert.equal(purposeBudgetNano("pages", 1, 0), 1_000_000_000);
  assert.equal(purposeBudgetNano("pages", 2, 0), 2_000_000_000);
  for (const purpose of TASK_SPEND_PURPOSES) {
    assert.equal(purposeBudgetNano(purpose, 1, 0), 0);
    assert.equal(purposeBudgetNano(purpose, 2, 0), 0);
  }
});

test("each account with the task manager on moves a tenth of its dollar to the task phases", () => {
  assert.equal(purposeBudgetNano("pages", 3, 1), 2_900_000_000);
  assert.equal(purposeBudgetNano("task_keeper", 3, 1), 100_000_000);
  assert.equal(purposeBudgetNano("pages", 3, 2), 2_800_000_000);
  assert.equal(purposeBudgetNano("task_links", 3, 2), 200_000_000);
  // The two soft caps always add up to the pooled cap.
  for (let accounts = 0; accounts <= 4; accounts++)
    for (let tasks = 0; tasks <= accounts; tasks++)
      for (const purpose of TASK_SPEND_PURPOSES)
        assert.equal(
          purposeBudgetNano("pages", accounts, tasks) +
            purposeBudgetNano(purpose, accounts, tasks),
          dailyBudgetNano(accounts),
          `${accounts} accounts, ${tasks} with tasks`,
        );
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
