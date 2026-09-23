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

test("the fourth and fifth attempts can recover without replacing the first returned judgment", async () => {
  for (const successfulAttempt of [4, 5]) {
    let clock = 0;
    const timeouts: number[] = [];
    const delays: number[] = [];
    const actual = await recoverJevTransport(
      async (attempt, timeoutMs) => {
        assert.equal(attempt, timeouts.length + 1);
        timeouts.push(timeoutMs);
        clock += 400;
        if (attempt < successfulAttempt) throw unavailable();
        return result;
      },
      {
        now: () => clock,
        wait: async (ms) => {
          delays.push(ms);
          clock += ms;
        },
      },
    );
    assert.deepEqual(
      timeouts,
      [30_000, 29_100, 27_200, 23_800, 17_400].slice(0, successfulAttempt),
    );
    assert.deepEqual(
      delays,
      [500, 1_500, 3_000, 6_000].slice(0, successfulAttempt - 1),
    );
    assert.deepEqual(actual.answers, result.answers);
    assert.deepEqual(actual.usage, result.usage);
    assert.equal(actual.transportFailures?.length, successfulAttempt - 1);
    assert.ok(clock < 30_000);
  }
});

test("persistent explicit outages stop after five attempts and retain all failures", async () => {
  let requests = 0;
  let clock = 0;
  const delays: number[] = [];
  await assert.rejects(
    recoverJevTransport(
      async () => {
        requests++;
        clock += 400;
        throw unavailable();
      },
      {
        now: () => clock,
        wait: async (ms) => {
          delays.push(ms);
          clock += ms;
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof JevRecoveryError);
      assert.equal(error.transportFailures.length, 5);
      assert.equal(error.status, 503);
      assert.ok(!error.message.includes("private"));
      return true;
    },
  );
  assert.equal(requests, 5);
  assert.deepEqual(delays, [500, 1_500, 3_000, 6_000]);
  assert.equal(clock, 13_000);
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
    ...[400, 402, 403, 404, 422].map(
      (status) =>
        new GatewayRequestError("non-retryable HTTP status", {
          status,
          // Even an incorrect caller flag cannot allow these HTTP statuses.
          retryable: true,
        }),
    ),
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

test("only explicit retryable 408, 429 and 5xx responses permit another attempt", async () => {
  for (const status of [408, 429, 500, 503, 599]) {
    let requests = 0;
    const actual = await recoverJevTransport(
      async () => {
        requests++;
        if (requests === 1)
          throw new GatewayRequestError("temporary HTTP response", {
            status,
            retryable: true,
          });
        return result;
      },
      { now: () => 0, wait: async () => {} },
    );
    assert.equal(requests, 2);
    assert.equal(actual.transportFailures?.[0].status, status);
  }
});

test("slow attempts leave only the remaining deadline and cannot enter the fifth attempt", async () => {
  let clock = 0;
  const timeouts: number[] = [];
  const delays: number[] = [];
  await assert.rejects(
    recoverJevTransport(
      async (_attempt, timeoutMs) => {
        timeouts.push(timeoutMs);
        clock += 6_000;
        throw unavailable();
      },
      {
        now: () => clock,
        wait: async (ms) => {
          delays.push(ms);
          clock += ms;
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof JevRecoveryError);
      assert.equal(error.transportFailures.length, 4);
      return true;
    },
  );
  assert.deepEqual(timeouts, [30_000, 23_500, 16_000, 7_000]);
  assert.deepEqual(delays, [500, 1_500, 3_000]);
  assert.equal(clock, 29_000);
});

test("Retry-After overrides backoff when it fits without renewing the deadline", async () => {
  let clock = 0;
  const timeouts: number[] = [];
  const delays: number[] = [];
  const actual = await recoverJevTransport(
    async (attempt, timeoutMs) => {
      timeouts.push(timeoutMs);
      if (attempt === 1)
        throw new GatewayRequestError("busy", {
          status: 429,
          retryable: true,
          retryAfterMs: 4_000,
        });
      return result;
    },
    {
      now: () => clock,
      wait: async (ms) => {
        delays.push(ms);
        clock += ms;
      },
    },
  );
  assert.deepEqual(timeouts, [30_000, 26_000]);
  assert.deepEqual(delays, [4_000]);
  assert.deepEqual(actual.answers, result.answers);
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
