import assert from "node:assert/strict";
import test from "node:test";
import {
  activitySchema,
  revisionSchema,
  revisionsSchema,
} from "../lib/brain/schemas";
import { paginationHref, paginationOffset } from "../lib/workspace/pagination";

test("history and activity pagination reject malformed offsets and retain canonical first-page URLs", () => {
  for (const value of [
    undefined,
    ["50"],
    "-1",
    "1.5",
    "Infinity",
    "9007199254740992",
    "invalid",
  ])
    assert.equal(paginationOffset(value), 0);
  assert.equal(paginationOffset("50"), 50);
  assert.equal(paginationHref("/activity", 0), "/activity");
  assert.equal(
    paginationHref("/pages/id/history", 50),
    "/pages/id/history?offset=50",
  );
  assert.equal(activitySchema.parse({}).offset, 0);
  assert.equal(revisionsSchema.parse({ ref: "page" }).offset, 0);
  assert.equal(revisionSchema.parse({ ref: "page", version: 1 }).version, 1);
  assert.equal(
    revisionSchema.safeParse({ ref: "page", version: 0 }).success,
    false,
  );
});
