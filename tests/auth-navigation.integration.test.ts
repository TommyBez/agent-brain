import assert from "node:assert/strict";
import test from "node:test";
import { WORKSPACE_PATH_HEADER } from "../lib/auth-navigation";

async function destination(response: Response, origin: URL) {
  let location = response.headers.get("location");
  if (!location) {
    const html = await response.text();
    location =
      html
        .match(/http-equiv="refresh" content="[^;]+;url=([^"]+)"/)?.[1]
        ?.replaceAll("&amp;", "&") ?? null;
  }
  assert.ok(location, "Unauthenticated workspace navigation must redirect");
  return new URL(location, origin);
}

test(
  "Next preserves private deep links across sign-in without changing API or MCP authentication",
  { skip: process.env.RUN_NEXT_TESTS !== "1", timeout: 60_000 },
  async (t) => {
    assert.ok(process.env.BRAIN_TEST_BASE_URL);
    const origin = new URL(process.env.BRAIN_TEST_BASE_URL);
    assert.equal(origin.protocol, "http:");
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname));
    assert.equal(origin.pathname, "/");
    const request = (path: string, init: RequestInit = {}) =>
      fetch(new URL(path, origin), {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
        headers: {
          "User-Agent": "Mozilla/5.0 AuthNavigationAcceptance",
          ...init.headers,
        },
      });

    await t.test(
      "collection query and old-revision paths survive authentication",
      async () => {
        for (const path of [
          "/projects?q=roadmap&sort=title",
          "/pages/ed6e8ffc-5e2f-4b0c-ae56-8b6db489ae7f/history/1",
        ]) {
          const redirect = await destination(await request(path), origin);
          assert.equal(redirect.origin, origin.origin);
          assert.equal(redirect.pathname, "/sign-in");
          assert.equal(redirect.searchParams.get("returnTo"), path);
        }
      },
    );

    await t.test(
      "incoming path headers cannot replace the user's destination",
      async () => {
        const redirect = await destination(
          await request("/projects?q=actual", {
            headers: { [WORKSPACE_PATH_HEADER]: "//evil.example/steal" },
          }),
          origin,
        );
        assert.equal(redirect.pathname, "/sign-in");
        assert.equal(
          redirect.searchParams.get("returnTo"),
          "/projects?q=actual",
        );
      },
    );

    await t.test(
      "headless clients still get 401 responses and OAuth discovery",
      async () => {
        const response = await request("/api/brain/pages");
        assert.equal(response.status, 401);
        assert.equal(response.headers.get("location"), null);
        assert.match(
          response.headers.get("content-type") ?? "",
          /application\/json/,
        );
        const mcp = await request("/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        assert.equal(mcp.status, 401);
        assert.equal(mcp.headers.get("location"), null);
        assert.match(
          mcp.headers.get("www-authenticate") ?? "",
          /resource_metadata=/,
        );
      },
    );
  },
);
