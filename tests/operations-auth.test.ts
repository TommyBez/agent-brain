import assert from "node:assert/strict";
import test from "node:test";
import { GET as cron } from "../app/api/cron/nightly/route";
import { POST } from "../app/api/operations/route";
import { isCronRequest } from "../lib/operations";

test("maintenance cannot be started with an agent or OAuth bearer token", async () => {
  for (const token of ["brain_scoped-agent-token", "interactive-oauth-token"]) {
    const response = await POST(
      new Request("https://brain.example/api/operations", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "session_required");
  }
});

test("Cron authenticates before touching the database or starting a workflow", async () => {
  const before = process.env.CRON_SECRET;
  try {
    process.env.CRON_SECRET = "cron-test-secret";
    for (const supplied of [
      undefined,
      "Bearer wrong",
      "Bearer cron-test-secrex",
    ]) {
      const request = new Request("https://brain.example/api/cron/nightly", {
        headers: supplied ? { authorization: supplied } : {},
      });
      assert.equal((await cron(request)).status, 401);
    }
    assert.equal(
      isCronRequest(
        new Request("https://brain.example/api/cron/nightly", {
          headers: { authorization: "Bearer cron-test-secret" },
        }),
      ),
      true,
    );
  } finally {
    if (before === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = before;
  }
});
