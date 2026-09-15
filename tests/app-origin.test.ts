import assert from "node:assert/strict";
import test from "node:test";
import { configuredAppOrigin } from "../lib/app-origin";

test("production uses the Vercel project domain instead of a stale auth URL", () => {
  assert.equal(
    configuredAppOrigin({
      VERCEL_ENV: "production",
      VERCEL_PROJECT_PRODUCTION_URL: "agent-brain.vercel.app",
      VERCEL_URL: "agent-brain-deployment.vercel.app",
      BETTER_AUTH_URL: "https://agent-brain-old.vercel.app",
    }),
    "https://agent-brain.vercel.app",
  );
});

test("preview uses its deployment domain, without trusting the production domain", () => {
  assert.equal(
    configuredAppOrigin({
      VERCEL_ENV: "preview",
      VERCEL_PROJECT_PRODUCTION_URL: "agent-brain.vercel.app",
      VERCEL_URL: "agent-brain-preview.vercel.app",
      BETTER_AUTH_URL: "https://agent-brain-old.vercel.app",
    }),
    "https://agent-brain-preview.vercel.app",
  );
});

test("missing Vercel system domains do not fall back to a different origin", () => {
  for (const env of [
    {
      VERCEL_ENV: "production",
      VERCEL_URL: "agent-brain-deployment.vercel.app",
      BETTER_AUTH_URL: "https://agent-brain-old.vercel.app",
    },
    {
      VERCEL_ENV: "preview",
      VERCEL_PROJECT_PRODUCTION_URL: "agent-brain.vercel.app",
      BETTER_AUTH_URL: "https://agent-brain-old.vercel.app",
    },
  ]) {
    assert.equal(configuredAppOrigin(env), undefined);
  }
});

test("Vercel system values must be bare, valid domains", () => {
  const malformedDomains = [
    "https://agent-brain.vercel.app",
    "http://agent-brain.vercel.app",
    "agent-brain.vercel.app/sign-in",
    "agent-brain.vercel.app?redirect=elsewhere",
    "agent-brain.vercel.app#fragment",
    "owner@agent-brain.vercel.app",
    "agent brain.vercel.app",
  ];
  for (const domain of malformedDomains) {
    assert.throws(() =>
      configuredAppOrigin({
        VERCEL_ENV: "production",
        VERCEL_PROJECT_PRODUCTION_URL: domain,
      }),
    );
    assert.throws(() =>
      configuredAppOrigin({ VERCEL_ENV: "preview", VERCEL_URL: domain }),
    );
  }
});

test("local and non-Vercel environments use the explicitly configured origin", () => {
  for (const origin of [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
    "https://brain.example.com",
  ]) {
    assert.equal(configuredAppOrigin({ BETTER_AUTH_URL: origin }), origin);
    assert.equal(
      configuredAppOrigin({
        VERCEL_ENV: "development",
        BETTER_AUTH_URL: origin,
      }),
      origin,
    );
  }
  assert.equal(configuredAppOrigin({}), undefined);
  assert.equal(
    configuredAppOrigin({ BETTER_AUTH_URL: "https://brain.example.com/" }),
    "https://brain.example.com",
  );
});

test("configured origins reject unsafe protocols, credentials and URL suffixes", () => {
  for (const origin of [
    "not a URL",
    "http://brain.example.com",
    "ftp://brain.example.com",
    "https://owner:password@brain.example.com",
    "https://brain.example.com/sign-in",
    "https://brain.example.com?next=/",
    "https://brain.example.com#fragment",
  ]) {
    assert.throws(() => configuredAppOrigin({ BETTER_AUTH_URL: origin }));
  }
});
