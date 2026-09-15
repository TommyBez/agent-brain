import assert from "node:assert/strict";
import test from "node:test";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import {
  safeReturnTo,
  signInHref,
  WORKSPACE_PATH_HEADER,
} from "../lib/auth-navigation";
import { config, proxy } from "../proxy";

test("sign-in keeps an internal destination, query filters and history version", () => {
  for (const path of [
    "/projects?q=roadmap&sort=title&offset=50",
    "/pages/ed6e8ffc-5e2f-4b0c-ae56-8b6db489ae7f/history/1",
    "/notes?tag=a&tag=b",
  ]) {
    assert.equal(safeReturnTo(path), path);
    assert.equal(
      new URL(signInHref(path), "https://brain.invalid").searchParams.get(
        "returnTo",
      ),
      path,
    );
  }
  assert.equal(
    safeReturnTo("/projects?q=hello%20world&_rsc=flight"),
    "/projects?q=hello+world",
  );
  assert.equal(signInHref("/"), "/sign-in");
});

test("untrusted return paths cannot become external redirects or auth loops", () => {
  for (const value of [
    undefined,
    null,
    "",
    "https://evil.example/projects",
    "//evil.example/projects",
    "/.//evil.example/projects",
    "/pages/..//evil.example/projects",
    "/%2e//evil.example/projects",
    "/\\evil.example/projects",
    "/%2f%2fevil.example",
    "/%5cevil.example",
    "/\nevil.example",
    "/pages/%0aexample",
    "javascript:alert(1)",
    "/sign-in?returnTo=/projects",
    "/api/auth/sign-out",
    "/pages/../api/auth/sign-out",
    "/mcp",
    "/_next/static/chunk.js",
  ]) {
    assert.equal(safeReturnTo(value), "/", `Reject ${String(value)}`);
    assert.equal(signInHref(value), "/sign-in");
  }
});

test("proxy derives the login destination from the actual request and overwrites spoofed headers", () => {
  const response = proxy(
    new NextRequest("https://brain.invalid/projects?q=actual&_rsc=flight", {
      headers: {
        [WORKSPACE_PATH_HEADER]: "//evil.example/steal",
        cookie: "session=preserved",
      },
    }),
  );
  assert.equal(
    response.headers.get(`x-middleware-request-${WORKSPACE_PATH_HEADER}`),
    "/projects?q=actual",
  );
  assert.equal(
    response.headers.get("x-middleware-request-cookie"),
    "session=preserved",
  );
  assert.equal(response.headers.get(WORKSPACE_PATH_HEADER), null);
  assert.equal(response.headers.get("location"), null);
});

test("proxy covers workspace deep links and leaves OAuth, MCP and assets alone", () => {
  for (const path of [
    "/",
    "/projects",
    "/people",
    "/pages/id/history/1",
    "/pages/new",
    "/operations",
  ]) {
    assert.equal(
      unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: path }),
      true,
      path,
    );
  }
  for (const path of [
    "/sign-in",
    "/consent",
    "/mcp",
    "/api/auth/oauth2/authorize",
    "/api/brain/pages",
    "/_next/static/chunk.js",
    "/favicon.ico",
  ]) {
    assert.equal(
      unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: path }),
      false,
      path,
    );
  }
});
