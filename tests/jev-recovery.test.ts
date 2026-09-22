import assert from "node:assert/strict";
import test from "node:test";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import {
  type ConsolidationEvaluation,
  JEV_MODEL,
} from "../lib/maintenance/jev";
import {
  JevRecoveryError,
  recoverJevTransport,
} from "../lib/maintenance/jev-recovery";

const result: ConsolidationEvaluation = {
  model: JEV_MODEL,
  answers: { supported_by_evidence: 0.99 },
  usage: { inputTokens: 20, outputTokens: 1, gateway: { cost: 0 } },
};
const unavailable = () =>
  new GatewayRequestError("private provider text", {
    status: 503,
    retryable: true,
  });

test("a recovered 503 preserves the first returned judgment and unknown failed usage", async () => {
  let requests = 0;
  const delays: number[] = [];
  const actual = await recoverJevTransport(
    async (attempt) => {
      assert.equal(attempt, ++requests);
      if (attempt === 1) throw unavailable();
      return result;
    },
    {
      wait: async (ms) => {
        delays.push(ms);
      },
    },
  );
  assert.equal(requests, 2);
  assert.deepEqual(delays, [500]);
  assert.deepEqual(actual.answers, result.answers);
  assert.deepEqual(actual.usage, result.usage);
  assert.deepEqual(actual.transportFailures, [
    { status: 503, retryable: true, retryAfterMs: null },
  ]);
  assert.ok(!JSON.stringify(actual).includes("private provider text"));
});

test("persistent explicit outages stop after three attempts and retain all failures", async () => {
  let requests = 0;
  await assert.rejects(
    recoverJevTransport(
      async () => {
        requests++;
        throw unavailable();
      },
      { wait: async () => {} },
    ),
    (error: unknown) => {
      assert.ok(error instanceof JevRecoveryError);
      assert.equal(error.transportFailures.length, 3);
      assert.equal(error.status, 503);
      assert.ok(!error.message.includes("private"));
      return true;
    },
  );
  assert.equal(requests, 3);
});

test("a returned adverse judgment, invalid contract and unknown transport outcome are never retried", async () => {
  let requests = 0;
  assert.equal(
    await recoverJevTransport(async () => {
      requests++;
      return result;
    }),
    result,
  );
  assert.equal(requests, 1);
  for (const error of [
    new GatewayRequestError("invalid contract", { retryable: false }),
    new GatewayRequestError("no HTTP response", { retryable: true }),
    new GatewayRequestError("not authenticated", {
      status: 401,
      retryable: false,
    }),
  ]) {
    let attempts = 0;
    await assert.rejects(
      recoverJevTransport(async () => {
        attempts++;
        throw error;
      }),
    );
    assert.equal(attempts, 1);
  }
});

test("Retry-After cannot extend the total request budget", async () => {
  let attempts = 0;
  await assert.rejects(
    recoverJevTransport(
      async () => {
        attempts++;
        throw new GatewayRequestError("busy", {
          status: 429,
          retryable: true,
          retryAfterMs: 60_000,
        });
      },
      { wait: async () => assert.fail("Must not wait beyond the budget") },
    ),
  );
  assert.equal(attempts, 1);
});

test("an overslept backoff cannot start another request after the deadline", async () => {
  let clock = 0;
  let attempts = 0;
  await assert.rejects(
    recoverJevTransport(
      async () => {
        attempts++;
        clock = 1;
        throw unavailable();
      },
      {
        now: () => clock,
        wait: async () => {
          clock = 31_000;
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof JevRecoveryError);
      assert.equal(error.transportFailures.length, 1);
      return true;
    },
  );
  assert.equal(attempts, 1);
});
