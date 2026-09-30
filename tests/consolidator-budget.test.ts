import assert from "node:assert/strict";
import test from "node:test";
import {
  actualCost,
  DAILY_BUDGET_NANO,
  EDITOR_MODEL,
  reserveCost,
} from "../lib/maintenance/consolidator/budget";

test("daily ceiling is one dollar and reservations include bounded editor output", () => {
  assert.equal(DAILY_BUDGET_NANO, 1e9);
  assert.ok(reserveCost({ model: EDITOR_MODEL, messages: [] }) >= 8192 * 1200);
  assert.ok(
    reserveCost({ model: "typesafe-ai/jev", state: "é".repeat(1000) }) >
      6000 * 42,
  );
  assert.throws(() => reserveCost({ model: "unpriced/model" }), /Unpriced/);
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
