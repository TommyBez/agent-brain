import assert from "node:assert/strict";
import test from "node:test";
import type { BrainPage } from "../lib/brain/types";
import { INDEXED_PRODUCER_REQUEST_LIMITS } from "../lib/maintenance/consolidation-producer";
import {
  assessCandidateAt,
  CANDIDATE_RUN_LIMITS,
  createCandidateRun,
  generateCandidateBatch,
} from "../lib/maintenance/consolidation-run";
import {
  GatewayRequestError,
  gatewayRequest,
} from "../lib/maintenance/gateway";
import { JEV_RECOVERY } from "../lib/maintenance/jev-recovery";
import { KIMI_EVALUATOR_SETTINGS } from "../lib/maintenance/kimi-evaluator";

test("Gateway preserves its default timeout and sends an override without altering the body or retrying", async (t) => {
  const previousKey = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "unit-test-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previousKey;
  });
  const deadlines: number[] = [];
  const requests: Array<{ url: unknown; body: unknown }> = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    deadlines.push(milliseconds);
    return new AbortController().signal;
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (url: unknown, init: RequestInit) => {
      requests.push({ url, body: init.body });
      if (requests.length === 4) throw new Error("synthetic timeout");
      return Response.json({ ok: true });
    },
  );
  const body = { model: "synthetic-model", input: "synthetic input" };
  await gatewayRequest("embeddings", body);
  await gatewayRequest("chat/completions", body);
  await gatewayRequest("chat/completions", body, { timeoutMs: 180_000 });
  await assert.rejects(
    gatewayRequest("chat/completions", body, { timeoutMs: 180_000 }),
    { message: "AI Gateway request failed or timed out.", retryable: true },
  );
  assert.equal(requests.length, 4);
  assert.deepEqual(deadlines, [120_000, 120_000, 180_000, 180_000]);
  assert.equal(requests[0].url, "https://ai-gateway.vercel.sh/v1/embeddings");
  assert.ok(requests.every((request) => request.body === JSON.stringify(body)));
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(gatewayRequest("embeddings", body, { timeoutMs }), {
      message: "AI Gateway request timeout is invalid.",
      retryable: false,
    });
  }
  assert.equal(requests.length, 4);
});

const page: BrainPage = {
  id: "synthetic-budget-page",
  slug: "project/budget",
  title: "Budget",
  type: "project",
  summary: "Fatto.",
  markdown: "# Progetto\n\nFatto.\n\nFatto.",
  aliases: [],
  tags: [],
  version: 1,
  createdAt: "2026-09-23",
  updatedAt: "2026-09-23",
  embeddedAt: null,
  links: [],
  backlinks: [],
};

test("candidate reservations cover the configured stage deadlines and stop before insufficient remaining time", async () => {
  assert.equal(CANDIDATE_RUN_LIMITS.durationMs, 25 * 60_000);
  assert.equal(
    CANDIDATE_RUN_LIMITS.maxGenerationMs,
    INDEXED_PRODUCER_REQUEST_LIMITS.selectionTimeoutMs +
      INDEXED_PRODUCER_REQUEST_LIMITS.rewriteTimeoutMs,
  );
  assert.equal(
    CANDIDATE_RUN_LIMITS.maxEvaluationMs,
    JEV_RECOVERY.totalTimeoutMs + KIMI_EVALUATOR_SETTINGS.maxTimeoutMs,
  );
  for (const remainingMs of [299_999, 300_000]) {
    const state = createCandidateRun([page], { now: 0 });
    let calls = 0;
    const result = await generateCandidateBatch(
      state,
      async () => {
        calls++;
        return {
          model: "synthetic-model",
          usage: { inputTokens: 1, outputTokens: 1 },
          proposals: [],
          rejectedProposals: [],
        };
      },
      state.deadlineAt - remainingMs,
    );
    assert.equal(calls, remainingMs === 300_000 ? 1 : 0);
    assert.equal(result.budgetReached, remainingMs < 300_000);
    assert.equal(state.generation, null);
  }
  for (const remainingMs of [209_999, 210_000]) {
    const state = createCandidateRun([page], { now: 0 });
    state.proposals = [
      {
        pageId: page.id,
        expectedVersion: 1,
        operation: "deduplicate_passage",
        reason: "Rimuove il duplicato.",
        evidence: [{ pageId: page.id, version: 1, quote: "Fatto." }],
        before: "Fatto.\n\nFatto.",
        after: "Fatto.",
      },
    ];
    let calls = 0;
    const result = await assessCandidateAt(
      state,
      0,
      async () => {
        calls++;
        throw new GatewayRequestError("Synthetic evaluation failure.", {
          retryable: false,
        });
      },
      state.deadlineAt - remainingMs,
    );
    assert.equal(calls, remainingMs === 210_000 ? 1 : 0);
    assert.equal(result.state.budgetReached, remainingMs < 210_000);
    assert.equal(state.entries.length, 0);
  }
});
