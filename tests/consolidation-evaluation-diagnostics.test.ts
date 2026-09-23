import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { withKimiFailureDiagnostic } from "../scripts/consolidation-evaluation-diagnostics";

async function privateDirectory() {
  const root = resolve("artifacts/consolidation");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "diagnostic-test-"));
}

test("failed evaluation retains only visible completion and numeric usage without changing request, response or error", async () => {
  const directory = await privateDirectory();
  try {
    const path = join(directory, "failure.json");
    const init: RequestInit = {
      method: "POST",
      headers: { Authorization: "PRIVATE_AUTH" },
      body: "PRIVATE_PROMPT",
    };
    const payload = {
      id: "completion-1",
      model: "moonshotai/kimi-k3",
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: "Visible malformed completion",
            reasoning: "PRIVATE_REASONING",
            reasoning_content: "PRIVATE_REASONING_CONTENT",
            tool_calls: ["PRIVATE_TOOLS"],
          },
        },
      ],
      usage: {
        prompt_tokens: 30,
        completion_tokens: 20,
        total_tokens: 50,
        cost: 0.01,
        prompt: "PRIVATE_USAGE_TEXT",
        details: { reasoning: "PRIVATE_USAGE_REASONING" },
      },
      provider_metadata: "PRIVATE_METADATA",
    };
    const response = Response.json(payload, {
      headers: { "x-private": "PRIVATE_RESPONSE_HEADER" },
    });
    const failure = new Error("PRIVATE_EVALUATOR_ERROR");
    let calls = 0;
    await assert.rejects(
      withKimiFailureDiagnostic(
        path,
        async (send) => {
          const received = await send("https://example.test/completions", init);
          assert.equal(received, response);
          assert.equal(received.bodyUsed, false);
          assert.deepEqual(await received.json(), payload);
          throw failure;
        },
        async (url, sent) => {
          calls++;
          assert.equal(url, "https://example.test/completions");
          assert.equal(sent, init);
          return response;
        },
      ),
      (error) => error === failure,
    );
    assert.equal(calls, 1);
    const saved = await readFile(path, "utf8");
    assert.equal(saved.includes("PRIVATE_"), false);
    assert.deepEqual(JSON.parse(saved), {
      message: { content: "Visible malformed completion" },
      finish_reason: "stop",
      model: "moonshotai/kimi-k3",
      id: "completion-1",
      usage: {
        prompt_tokens: 30,
        completion_tokens: 20,
        total_tokens: 50,
        cost: 0.01,
      },
    });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("successful evaluation returns its original result and creates no diagnostic file", async () => {
  const directory = await privateDirectory();
  try {
    const path = join(directory, "success.json");
    const result = { verdict: "pass" };
    let calls = 0;
    const actual = await withKimiFailureDiagnostic(
      path,
      async (send) => {
        const response = await send("https://example.test/completions");
        assert.deepEqual(await response.json(), {
          choices: [{ message: { content: "Visible success" } }],
        });
        return result;
      },
      async () => {
        calls++;
        return Response.json({
          choices: [{ message: { content: "Visible success" } }],
        });
      },
    );
    assert.equal(actual, result);
    assert.equal(calls, 1);
    await assert.rejects(stat(path), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
