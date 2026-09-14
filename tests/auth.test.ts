import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthError,
  assertSameOrigin,
  newAgentToken,
  requireScope,
  tokenHash,
} from "../lib/auth-principal";

test("headless credentials contain 256 random bits and only their hash is used for storage", () => {
  const first = newAgentToken();
  const second = newAgentToken();
  assert.match(first, /^brain_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.equal(tokenHash(first).length, 64);
  assert.notEqual(tokenHash(first), first);
});

test("read permission cannot authorize a write or maintenance action", () => {
  const principal = {
    ownerId: "owner",
    kind: "token" as const,
    scopes: ["brain:read"],
  };
  requireScope(principal, "brain:read");
  assert.throws(
    () => requireScope(principal, "brain:write"),
    (error: unknown) => error instanceof AuthError && error.status === 403,
  );
  assert.throws(() => requireScope(principal, "brain:maintain"), AuthError);
});

test("cookie mutation origin is checked against configuration, not an attacker-controlled URL", () => {
  const previous = process.env.BETTER_AUTH_URL;
  process.env.BETTER_AUTH_URL = "https://brain.example.com";
  try {
    assertSameOrigin(
      new Request("https://brain.example.com/api/agent-tokens", {
        headers: { origin: "https://brain.example.com" },
      }),
    );
    assert.throws(
      () =>
        assertSameOrigin(
          new Request("https://evil.example/api/agent-tokens", {
            headers: { origin: "https://evil.example" },
          }),
        ),
      AuthError,
    );
    assert.throws(
      () =>
        assertSameOrigin(
          new Request("https://brain.example.com/api/agent-tokens"),
        ),
      AuthError,
    );
  } finally {
    if (previous) process.env.BETTER_AUTH_URL = previous;
    else delete process.env.BETTER_AUTH_URL;
  }
});
