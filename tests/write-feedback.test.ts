import assert from "node:assert/strict";
import test from "node:test";
import { PAGE_TYPES } from "../lib/brain/types";
import type { EvaluationRequest } from "../lib/maintenance/consolidator/types";
import { type GatewayCall, gatewayRequest } from "../lib/maintenance/gateway";
import { LOG_FEEDBACK, writeWithFeedback } from "../lib/mcp/write-feedback";

function answer(score: number): GatewayCall {
  return async <T>(_path: string, body: unknown) => {
    const request = body as EvaluationRequest;
    assert.deepEqual(Object.keys(request.questions), ["log"]);
    return {
      model: "typesafe-ai/jev-1.14.0",
      answers: { log: { type: "boolean", probability: score } },
    } as T;
  };
}

test("all page types return score, warn on logs, and preserve the saved page", async () => {
  // These are transport/policy tests with controlled judgments; semantic
  // acceptance of the actual examples is measured by the live synthetic eval.
  for (const type of PAGE_TYPES) {
    for (const [markdown, score, warns] of [
      ["l'azienda X è stata fondata nel 2026", 0.01, false],
      ["Tizio lavora in Y dal 2020", 0.02, false],
      ["kick off del progetto il 20/02/2025", 0.03, false],
      ["## Aggiornamento 12/11\nSiamo in beta.", 0.99, true],
      ["## Stato (13/11)\nBeta\n## Stato precedente\nPrototipo", 0.98, true],
    ] as const) {
      const page = { type, title: "Synthetic", markdown, version: 2 };
      const result = await writeWithFeedback(
        async () => page,
        { operation: "write", markdown },
        answer(score),
      );
      assert.equal(result.writeEvaluation?.score, score);
      assert.equal(
        result.writeEvaluation?.feedback,
        warns ? LOG_FEEDBACK : undefined,
      );
      assert.equal(result.markdown, markdown);
      assert.equal(result.version, 2);
      assert.equal("writeEvaluation" in page, false);
    }
  }
});

test("append judges the changed text in full saved context, after save", async () => {
  let saved = false;
  const markdown = "## Aggiornamento 12/11\nBeta";
  const page = {
    type: "project",
    title: "Synthetic",
    markdown: `## Stato\nPrototipo\n${markdown}`,
  };
  const send: GatewayCall = async <T>(
    path: string,
    body: unknown,
    options?: { signal?: AbortSignal },
  ) => {
    assert.equal(saved, true);
    assert.ok(options?.signal);
    const request = body as EvaluationRequest;
    assert.deepEqual(request.state, {
      page,
      change: { operation: "append", markdown },
    });
    return answer(0.99)<T>(path as "evaluate", body);
  };
  const result = await writeWithFeedback(
    async () => {
      saved = true;
      return page;
    },
    { operation: "append", markdown },
    send,
  );
  assert.equal(result.writeEvaluation?.feedback, LOG_FEEDBACK);
});

test("JEV errors, malformed responses and gateway timeout leave writes successful with no evaluation", async (t) => {
  const page = {
    type: "note",
    title: "Synthetic",
    markdown: "## Aggiornamento 12/11",
  };
  const failing: GatewayCall = async () => {
    throw new Error("provider failed");
  };
  const invalid: GatewayCall = async <T>() =>
    ({ model: "jev", answers: {} }) as T;
  for (const send of [failing, invalid]) {
    assert.strictEqual(
      await writeWithFeedback(
        async () => page,
        { operation: "write", markdown: page.markdown },
        send,
      ),
      page,
    );
  }
  // Exercise the real Gateway abort path without waiting eight seconds.
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      assert.ok(init.signal);
      throw new DOMException("synthetic timeout", "TimeoutError");
    },
  );
  t.mock.method(AbortSignal, "timeout", () =>
    AbortSignal.abort(new DOMException("synthetic timeout", "TimeoutError")),
  );
  const previous = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "test-only";
  try {
    assert.strictEqual(
      await writeWithFeedback(
        async () => page,
        { operation: "append", markdown: page.markdown },
        gatewayRequest,
      ),
      page,
    );
  } finally {
    if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previous;
  }
});

test("save errors still propagate and never call JEV", async () => {
  const conflict = new Error("VERSION_CONFLICT");
  await assert.rejects(
    writeWithFeedback(
      async () => {
        throw conflict;
      },
      { operation: "write", markdown: "x" },
      async () => {
        assert.fail("must not evaluate a failed save");
      },
    ),
    (error) => error === conflict,
  );
});
