import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SEED_DECISION_POLICY } from "../lib/maintenance/consolidator/decision-policy";
import type {
  AnalysisResult,
  Evaluation,
  EvaluationRequest,
} from "../lib/maintenance/consolidator/types";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import {
  assessAnalysis,
  classifyVerification,
  diagnoseRawEvaluation,
  digest,
  JudgmentCache,
  readRawEvaluation,
  sanitizeDiagnostic,
  verifierSignals,
} from "../scripts/lib/consolidator-calibration";

test("raw successful HTTP responses survive parser failure and are replayed without another provider request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "consolidator-raw-"));
  let calls = 0;
  try {
    const options = {
      directory,
      live: true,
      maxCalls: 10,
      timeoutMs: 10000,
      concurrency: 2,
      retries: 3,
      provider: async () => {
        calls++;
        return answer;
      },
    };
    const cache = new JudgmentCache(options);
    const body = JSON.stringify({ model: "typesafe-ai/jev", ...request });
    const invalidBody = JSON.stringify({
      model: "typesafe-ai/jev",
      answers: {
        objective: { type: "boolean", probability: 0.8, unexpected: true },
      },
    });
    const response = await cache.captureRawResponse(
      body,
      new Response(invalidBody, { status: 200 }),
    );
    assert.equal(await response.text(), invalidBody);
    await assert.rejects(cache.evaluate(request), /invalid evaluation/);
    assert.equal(calls, 0);
    const resumed = new JudgmentCache(options);
    await assert.rejects(resumed.evaluate(request), /invalid evaluation/);
    assert.equal(calls, 0);
    const firstWins = await resumed.captureRawResponse(
      body,
      new Response(
        JSON.stringify({ model: "typesafe-ai/jev", answers: answer.answers }),
        { status: 200 },
      ),
    );
    assert.equal(await firstWins.text(), invalidBody);
    const raw = await readRawEvaluation(
      directory,
      digest({ model: "typesafe-ai/jev", ...request }),
    );
    assert.ok(raw);
    const diagnosis = diagnoseRawEvaluation(raw) as {
      valid: boolean;
      answers: { issues: string[] }[];
    };
    assert.equal(diagnosis.valid, false);
    assert.ok(diagnosis.answers[0].issues.includes("unknown_answer_fields"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("raw valid evaluations can be parsed offline and provider identifiers never enter normalized reports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "consolidator-raw-valid-"));
  try {
    const cache = new JudgmentCache({
      directory,
      live: false,
      maxCalls: 10,
      timeoutMs: 10000,
      concurrency: 2,
      retries: 3,
    });
    const body = JSON.stringify({ model: "typesafe-ai/jev", ...request });
    const rawBody = JSON.stringify({
      model: "typesafe-ai/jev",
      answers: answer.answers,
      usage: { inputTokens: 20, outputTokens: 2 },
      providerMetadata: {
        api_key_id: "fictional-private-id",
        typesafe: {
          note: "Quota api_key_id_fake_123 inactive",
          confidence: {},
        },
      },
    });
    await cache.captureRawResponse(
      body,
      new Response(rawBody, { status: 200 }),
    );
    const evaluation = await cache.evaluate(request);
    assert.equal(cache.stats.calls, 0);
    const normalized = JSON.stringify(evaluation);
    assert.ok(!normalized.includes("fictional-private-id"));
    assert.ok(!normalized.includes("fake_123"));
    assert.equal(
      sanitizeDiagnostic('Quota entity "api_key_id_fake_123" inactive'),
      'Quota entity "api_key_id_[redacted]" inactive',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("new experiments reuse only requested exact keys without importing unrelated observed cases", async () => {
  const sourceDirectory = await mkdtemp(join(tmpdir(), "consolidator-origin-"));
  const targetDirectory = await mkdtemp(join(tmpdir(), "consolidator-next-"));
  try {
    const source = new JudgmentCache({
      directory: sourceDirectory,
      live: true,
      maxCalls: 10,
      timeoutMs: 10000,
      concurrency: 2,
      retries: 0,
      provider: async () => answer,
    });
    const observedHoldoutRequest = {
      ...request,
      state: { previouslyObservedHoldout: true },
    };
    for (const item of [request, observedHoldoutRequest]) {
      await source.captureRawResponse(
        JSON.stringify({ model: "typesafe-ai/jev", ...item }),
        new Response(
          JSON.stringify({
            model: "typesafe-ai/jev",
            answers: answer.answers,
            usage: { inputTokens: 20, outputTokens: 2 },
          }),
          { status: 200 },
        ),
      );
      await source.evaluate(item);
    }
    const originalFiles = await readdir(join(sourceDirectory, "judgments"));
    assert.equal(originalFiles.length, 2);
    const target = new JudgmentCache({
      directory: targetDirectory,
      live: false,
      maxCalls: 10,
      timeoutMs: 10000,
      concurrency: 2,
      retries: 0,
      reuseDirectories: [sourceDirectory],
      provider: async () => {
        throw new Error("Reusing a frozen judgment must never call provider.");
      },
    });
    assert.deepEqual(await target.evaluate(request), answer);
    assert.equal(target.stats.reused, 1);
    assert.equal(target.stats.calls, 0);
    const expectedFilename = `${digest({ model: "typesafe-ai/jev", ...request })}.json`;
    assert.deepEqual(await readdir(join(targetDirectory, "judgments")), [
      expectedFilename,
    ]);
    assert.deepEqual(await readdir(join(targetDirectory, "raw-http")), [
      expectedFilename,
    ]);
    assert.deepEqual(
      await readdir(join(sourceDirectory, "judgments")),
      originalFiles,
    );
  } finally {
    await rm(sourceDirectory, { recursive: true, force: true });
    await rm(targetDirectory, { recursive: true, force: true });
  }
});

const request: EvaluationRequest = {
  state: { synthetic: true },
  questions: {
    objective: {
      type: "boolean",
      instructions:
        "Does this fixed synthetic result accomplish its objective?",
    },
  },
};
const answer: Evaluation = {
  model: "typesafe-ai/jev",
  answers: { objective: { type: "boolean", probability: 0.81 } },
  inputTokens: 20,
  outputTokens: 2,
};

test("calibration caches a successful semantic judgment across concurrent calls and offline restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "consolidator-cache-"));
  let calls = 0;
  try {
    const cache = new JudgmentCache({
      directory,
      live: true,
      maxCalls: 10,
      timeoutMs: 10000,
      concurrency: 2,
      retries: 3,
      provider: async () => {
        calls++;
        return answer;
      },
    });
    const results = await Promise.all([
      cache.evaluate(request),
      cache.evaluate(request),
    ]);
    assert.deepEqual(results, [answer, answer]);
    assert.equal(calls, 1);
    const offline = new JudgmentCache({
      directory,
      live: false,
      maxCalls: 10,
      timeoutMs: 10000,
      concurrency: 2,
      retries: 3,
      provider: async () => {
        throw new Error("Must never call a provider offline.");
      },
    });
    assert.deepEqual(await offline.evaluate(request), answer);
    assert.equal(offline.stats.calls, 0);
    const key = digest({ model: "typesafe-ai/jev", ...request });
    const path = join(directory, "judgments", `${key}.json`);
    const stored = JSON.parse(await readFile(path, "utf8"));
    stored.request.state = { corrupted: true };
    await writeFile(path, JSON.stringify(stored));
    const corrupted = new JudgmentCache({
      directory,
      live: true,
      maxCalls: 10,
      timeoutMs: 10000,
      concurrency: 2,
      retries: 3,
      provider: async () => {
        throw new Error("Do not reroll corrupt cache.");
      },
    });
    await assert.rejects(corrupted.evaluate(request), /identity failed/);
    assert.equal(corrupted.stats.calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("transport retries stop at the first success and a protocol failure is not retried", async () => {
  const directory = await mkdtemp(join(tmpdir(), "consolidator-retry-"));
  let calls = 0;
  try {
    const cache = new JudgmentCache({
      directory,
      live: true,
      maxCalls: 10,
      timeoutMs: 10000,
      concurrency: 2,
      retries: 3,
      provider: async () => {
        calls++;
        if (calls === 1)
          throw new GatewayRequestError("temporary", {
            retryable: true,
            status: 503,
          });
        return answer;
      },
    });
    await cache.evaluate(request);
    await cache.evaluate(request);
    assert.equal(calls, 2);
    assert.equal(cache.stats.retries, 1);
    let badCalls = 0;
    const invalid = new JudgmentCache({
      directory,
      live: true,
      maxCalls: 10,
      timeoutMs: 10000,
      concurrency: 2,
      retries: 3,
      provider: async () => {
        badCalls++;
        return { ...answer, answers: {} };
      },
    });
    const different = { ...request, state: { another: true } };
    await assert.rejects(invalid.evaluate(different), /invalid evaluation/);
    await assert.rejects(invalid.evaluate(different), /invalid evaluation/);
    assert.equal(badCalls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("analysis calibration counts an incorrect link direction even when add_link is allowed", () => {
  const result: AnalysisResult = {
    taskId: "synthetic",
    status: "complete",
    judgments: [],
    findings: [
      {
        id: "wrong",
        kind: "add_link",
        status: "supported",
        pageIds: ["person", "company"],
        unitIds: ["a"],
        evidenceUnitIds: ["a"],
        link: { sourceId: "company", targetId: "person", type: "works_at" },
        goal: "Wrong direction",
      },
    ],
  };
  const expected = {
    required: ["add_link" as const],
    allowed: ["add_link" as const],
    requiredLinks: [
      { sourceId: "person", targetId: "company", type: "works_at" as const },
    ],
    allowedLinks: [
      { sourceId: "person", targetId: "company", type: "works_at" as const },
    ],
  };
  const assessment = assessAnalysis(result, expected);
  assert.equal(assessment.outcome, "false_accept");
  assert.equal(assessment.unexpectedLinks.length, 1);
  assert.equal(assessment.missingLinks.length, 1);
});

test("offline verifier families reproduce AND gates without weakening an integrity violation", () => {
  const questions = {
    ...request.questions,
    preservation_0: { type: "boolean" as const, instructions: "Preserved?" },
    no_human_work: { type: "boolean" as const, instructions: "No new work?" },
  };
  const signals = verifierSignals({
    status: "uncertain",
    defects: [],
    judgments: [
      {
        ...request,
        questions,
        ...answer,
        answers: {
          objective: { type: "boolean", probability: 0.72 },
          preservation_0: { type: "boolean", probability: 0.92 },
          no_human_work: { type: "boolean", probability: 0.99 },
        },
      },
    ],
  });
  assert.equal(
    classifyVerification(signals, SEED_DECISION_POLICY),
    "uncertain",
  );
  assert.equal(
    classifyVerification(signals, {
      ...SEED_DECISION_POLICY,
      verifier: {
        ...SEED_DECISION_POLICY.verifier,
        objective: 0.7,
        integrity: 0.95,
      },
    }),
    "uncertain",
  );
  assert.equal(
    classifyVerification(signals, {
      ...SEED_DECISION_POLICY,
      verifier: { ...SEED_DECISION_POLICY.verifier, objective: 0.7 },
    }),
    "accepted",
  );
  assert.equal(
    classifyVerification(
      { ...signals, incomplete: true },
      SEED_DECISION_POLICY,
    ),
    "error",
  );
});
