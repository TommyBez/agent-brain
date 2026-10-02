import assert from "node:assert/strict";
import test from "node:test";
import {
  actualCost,
  DAILY_BUDGET_NANO,
  dailyBudgetNano,
  EDITOR_MODEL,
} from "../lib/maintenance/consolidator/budget";

test("daily spending target is one dollar for each present account", () => {
  assert.equal(DAILY_BUDGET_NANO, 1e9);
  assert.equal(dailyBudgetNano(1), 1e9);
  assert.equal(dailyBudgetNano(3), 3e9);
  assert.equal(dailyBudgetNano(0), 0);
});

test("actual spend prefers Gateway cost and includes both editor input and output", () => {
  assert.equal(
    actualCost(
      { providerMetadata: { gateway: { cost: "0.002" } } },
      "typesafe-ai/jev",
    ),
    2_000_000,
  );
  assert.equal(
    actualCost({ usage: { inputTokens: 1000 } }, "typesafe-ai/jev"),
    42000,
  );
  assert.equal(
    actualCost(
      { usage: { prompt_tokens: 1000, completion_tokens: 2000 } },
      EDITOR_MODEL,
    ),
    2_700_000,
  );
  assert.equal(actualCost({}, EDITOR_MODEL), null);
  assert.equal(
    actualCost(
      { usage: { prompt_tokens: -1, completion_tokens: 0 } },
      EDITOR_MODEL,
    ),
    null,
  );
});

test("an empty provider cost is unknown rather than a free call", () => {
  assert.equal(actualCost({ usage: { cost: "" } }, EDITOR_MODEL), null);
});
