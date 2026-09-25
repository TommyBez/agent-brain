import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CONSOLIDATION_QUESTIONS_V2,
  type ConsolidationCriterion,
} from "../lib/maintenance/consolidation-rubric";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import { JEV_MODEL } from "../lib/maintenance/jev";
import {
  KIMI_MODEL,
  type KimiEvaluation,
} from "../lib/maintenance/kimi-evaluator";
import {
  cascadeCriteria,
  cascadeHash,
  hashCascadeText,
  runCascade,
} from "../scripts/evaluate-consolidation-cascade";
import {
  CASCADE_METHOD,
  type DevelopmentCase,
  deriveCascadeBands,
} from "../scripts/prepare-consolidation-cascade";

const keys = cascadeCriteria;
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const save = async (path: string, value: unknown) =>
  writeFile(path, JSON.stringify(value));
function evaluation(
  scores: Partial<Record<ConsolidationCriterion, number>> = {},
) {
  const answers = Object.fromEntries(
    keys.map((key) => [key, scores[key] ?? 0.95]),
  );
  return {
    model: JEV_MODEL,
    answers,
    usage: {
      inputTokens: 10,
      outputTokens: 1,
      totalTokens: 11,
      gateway: { cost: 0.001 },
    },
  };
}
function kimi(
  criteria: ConsolidationCriterion[],
  overrides: Partial<
    Record<ConsolidationCriterion, "pass" | "fail" | "uncertain">
  > = {},
): KimiEvaluation {
  return {
    model: KIMI_MODEL,
    responseModel: "provider/kimi",
    responseId: "request-id",
    judgments: Object.fromEntries(
      criteria.map((key) => [
        key,
        {
          verdict: overrides[key] ?? "pass",
          rationale: "Synthetic independent judgment.",
        },
      ]),
    ),
    latencyMs: 12,
    usage: {
      inputTokens: 30,
      outputTokens: 10,
      totalTokens: 40,
      reasoningTokens: 5,
      cachedInputTokens: 0,
      costUsd: 0.004,
    },
  };
}
async function fixture(count = 4) {
  const input = await mkdtemp(join(tmpdir(), "brain-cascade-"));
  const cases = Array.from({ length: count }, (_, index) => {
    const input = {
      before: { index, text: "Fact. Fact." },
      after: "Fact.",
      evidence: ["Fact."],
      operation: "deduplicate",
    };
    return { caseId: `case-${index}`, inputHash: cascadeHash(input), input };
  });
  const rubricText = `${JSON.stringify(CONSOLIDATION_QUESTIONS_V2, null, 2)}\n`;
  const review = {
    reviewer: "blind-subagent",
    rubricHash: hashCascadeText(rubricText),
    candidates: cases.map((item) => ({
      caseId: item.caseId,
      inputHash: item.inputHash,
      criteria: Object.fromEntries(
        keys.map((key) => [
          key,
          { verdict: "pass", rationale: "BLIND_LABEL_PRIVATE" },
        ]),
      ),
    })),
  };
  const bands = {
    criteria: Object.fromEntries(
      keys.map((key) => [key, { rejectBelow: 0.2, acceptAtOrAbove: 0.9 }]),
    ),
  };
  await Promise.all([
    save(join(input, "cases.json"), { cases }),
    save(join(input, "subagent-review.json"), review),
    save(join(input, "partition.json"), {
      cases: cases.map((item, index) => ({
        caseId: item.caseId,
        familyId: `family-${index}`,
        variantId: "good",
        targetCriterion: null,
      })),
    }),
    save(join(input, "evaluation-spec.json"), {
      repetitions: 1,
      expectedCases: count,
      model: JEV_MODEL,
      kimiModel: KIMI_MODEL,
      designCodeHashes: {},
    }),
    save(join(input, "bands.json"), bands),
    writeFile(join(input, "rubric.json"), rubricText),
  ]);
  return { input, cases, review, bands };
}

test("routing requests gray criteria only, keeps independent all-criterion baseline, replaces individual verdicts and resumes without calls", async () => {
  const data = await fixture(5);
  let jevCalls = 0;
  const calls: { index: number; criteria: ConsolidationCriterion[] }[] = [];
  let active = 0;
  let maxActive = 0;
  try {
    const jev = await runCascade(
      { input: data.input, stage: "jev" },
      {
        evaluateJev: async (input, options) => {
          jevCalls++;
          assert.equal(options?.questions, CONSOLIDATION_QUESTIONS_V2);
          assert.deepEqual(Object.keys(input), [
            "before",
            "after",
            "evidence",
            "operation",
          ]);
          const protocol = await json(join(data.input, "protocol.json"));
          assert.ok(protocol.artifactHashes["bands.json"]);
          assert.ok(protocol.codeHashes["lib/maintenance/kimi-evaluator.ts"]);
          const index = (input.before as { index: number }).index;
          if (index === 0)
            return evaluation({
              supported_by_evidence: 0.1,
              no_new_human_action: 0.5,
            });
          if (index === 1) return evaluation();
          if (index === 2) return evaluation({ supported_by_evidence: 0.5 });
          if (index === 3)
            return evaluation({
              supported_by_evidence: 0.2,
              meaningful_improvement: 0.5,
            });
          return evaluation(Object.fromEntries(keys.map((key) => [key, 0.5])));
        },
      },
    );
    assert.equal(jevCalls, 5);
    assert.deepEqual(jev.totals.states, {
      red: 1,
      green: 1,
      gray: 3,
      error: 0,
    });
    const summary = await runCascade(
      { input: data.input, stage: "kimi" },
      {
        evaluateKimi: async (input, criteria, options) => {
          const index = (input.before as { index: number }).index;
          assert.equal(options, undefined);
          assert.deepEqual(input, data.cases[index].input);
          assert.ok(
            !JSON.stringify([input, criteria]).includes("BLIND_LABEL_PRIVATE"),
          );
          calls.push({ index, criteria: [...criteria] });
          maxActive = Math.max(maxActive, ++active);
          await new Promise<void>((done) => setTimeout(done, 10));
          active--;
          if (index === 2 && criteria.length === 1)
            return kimi(criteria, { supported_by_evidence: "fail" });
          if (index === 3 && criteria.length === 2)
            return kimi(criteria, { supported_by_evidence: "uncertain" });
          return kimi(criteria);
        },
      },
    );
    assert.equal(calls.length, 8);
    assert.equal(maxActive, 3);
    for (const index of [0, 1])
      assert.deepEqual(
        calls
          .filter((call) => call.index === index)
          .map((call) => call.criteria),
        [[...keys]],
      );
    assert.deepEqual(
      calls.filter((call) => call.index === 2).map((call) => call.criteria),
      [[...keys], ["supported_by_evidence"]],
    );
    assert.deepEqual(
      calls.filter((call) => call.index === 3).map((call) => call.criteria),
      [["supported_by_evidence", "meaningful_improvement"], [...keys]],
    );
    assert.deepEqual(
      calls.filter((call) => call.index === 4).map((call) => call.criteria),
      [[...keys], [...keys]],
    );
    assert.equal(summary.byCase[0].arms.cascade.verdict, "fail");
    assert.equal(summary.byCase[0].selective.mode, "auto-reject");
    assert.equal(summary.byCase[0].arms.kimiOnly.verdict, "pass");
    assert.equal(summary.byCase[1].arms.cascade.verdict, "pass");
    assert.equal(summary.byCase[2].arms.cascade.verdict, "fail");
    assert.equal(
      summary.byCase[2].arms.cascade.criteria.preserves_distinct_information,
      "pass",
    );
    assert.equal(summary.byCase[2].arms.kimiOnly.verdict, "pass");
    assert.equal(summary.byCase[3].arms.cascade.verdict, "uncertain");
    assert.equal(summary.totals.actual.jobs, 13);
    assert.equal(summary.totals.byArm.cascade.jobs, 8);
    assert.equal(summary.totals.reusedCalls, 0);
    assert.equal(summary.totals.actual.usage.costUsd.missingJobs, 0);
    assert.ok(
      Math.abs(summary.totals.actual.usage.costUsd.known - 0.037) < 1e-10,
    );
    assert.equal((await stat(data.input)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(data.input, "receipts/0001-jev.json"))).mode & 0o777,
      0o600,
    );
    const fail = async (): Promise<never> =>
      assert.fail("Complete resume or verify-only must not call providers");
    assert.deepEqual(
      await runCascade(
        { input: data.input, stage: "kimi" },
        { evaluateJev: fail, evaluateKimi: fail },
      ),
      summary,
    );
    assert.deepEqual(
      await runCascade(
        { input: data.input, stage: "kimi" },
        { verifyOnly: true, evaluateJev: fail, evaluateKimi: fail },
      ),
      summary,
    );
    assert.deepEqual(
      await runCascade(
        { input: data.input, stage: "jev" },
        { verifyOnly: true, evaluateJev: fail, evaluateKimi: fail },
      ),
      jev,
    );
  } finally {
    await rm(data.input, { recursive: true, force: true });
  }
});

test("a sentinel upper threshold disables automatic passing even for Jev score one", async () => {
  const data = await fixture(1);
  try {
    data.bands.criteria.supported_by_evidence.acceptAtOrAbove = 1.01;
    await save(join(data.input, "bands.json"), data.bands);
    await runCascade(
      { input: data.input, stage: "jev" },
      { evaluateJev: async () => evaluation({ supported_by_evidence: 1 }) },
    );
    const criteriaSeen: ConsolidationCriterion[][] = [];
    const result = await runCascade(
      { input: data.input, stage: "kimi" },
      {
        evaluateKimi: async (_, criteria) => {
          criteriaSeen.push(criteria);
          return kimi(criteria);
        },
      },
    );
    assert.deepEqual(criteriaSeen, [[...keys], ["supported_by_evidence"]]);
    assert.equal(result.byCase[0].routing.state, "gray");
  } finally {
    await rm(data.input, { recursive: true, force: true });
  }
});

test("all Jev jobs must resolve before Kimi; incomplete verification makes no calls", async () => {
  const data = await fixture();
  let calls = 0;
  const evaluateJev = async () => {
    calls++;
    return evaluation();
  };
  const evaluateKimi = async (
    _: unknown,
    criteria: ConsolidationCriterion[],
  ) => {
    calls++;
    return kimi(criteria);
  };
  try {
    await assert.rejects(
      runCascade(
        { input: data.input, stage: "jev" },
        { verifyOnly: true, evaluateJev },
      ),
      /complete saved stage/,
    );
    await assert.rejects(
      runCascade({ input: data.input, stage: "kimi" }, { evaluateKimi }),
      /all Jev jobs resolved/,
    );
    assert.equal(calls, 0);
    await runCascade({ input: data.input, stage: "jev" }, { evaluateJev });
    assert.equal(calls, 4);
    await assert.rejects(
      runCascade(
        { input: data.input, stage: "kimi" },
        { verifyOnly: true, evaluateKimi },
      ),
      /complete saved stage/,
    );
    assert.equal(calls, 4);
  } finally {
    await rm(data.input, { recursive: true, force: true });
  }
});

test("failures are preserved per arm; only explicit retryable 429 and 5xx retry and no failure approves", async () => {
  const data = await fixture(5);
  const jevCalls = new Map<number, number>();
  const kimiCalls = new Map<number, number>();
  try {
    const first = await runCascade(
      { input: data.input, stage: "jev" },
      {
        sleep: async () => {},
        evaluateJev: async (input) => {
          const index = (input.before as { index: number }).index;
          const count = (jevCalls.get(index) ?? 0) + 1;
          jevCalls.set(index, count);
          if (index === 0 && count < 3)
            throw new GatewayRequestError("PRIVATE_BODY", {
              retryable: true,
              status: 429,
            });
          if (index === 1)
            throw new GatewayRequestError("PRIVATE_BODY", { retryable: true });
          if (index === 2)
            throw new GatewayRequestError("PRIVATE_BODY", {
              retryable: true,
              status: 500,
            });
          if (index === 3)
            throw new GatewayRequestError("PRIVATE_BODY", {
              retryable: true,
              status: 408,
            });
          return evaluation({ supported_by_evidence: 0.5 });
        },
      },
    );
    assert.deepEqual(
      [...jevCalls].sort((a, b) => a[0] - b[0]),
      [
        [0, 3],
        [1, 1],
        [2, 3],
        [3, 1],
        [4, 1],
      ],
    );
    assert.equal(first.status, "completed_with_errors");
    assert.equal(first.totals.byCall.jev.failedJobs, 3);
    const summary = await runCascade(
      { input: data.input, stage: "kimi" },
      {
        evaluateKimi: async (input, criteria) => {
          const index = (input.before as { index: number }).index;
          kimiCalls.set(index, (kimiCalls.get(index) ?? 0) + 1);
          if (index === 4 && criteria.length === 1)
            throw new GatewayRequestError("PRIVATE_BODY", { retryable: false });
          if (index === 0 && criteria.length === 4)
            return { ...kimi(criteria), judgments: {} };
          return kimi(criteria);
        },
      },
    );
    assert.equal(summary.byCase[0].arms.kimiOnly.verdict, "error");
    assert.equal(summary.byCase[0].arms.cascade.verdict, "pass");
    for (const index of [1, 2, 3]) {
      assert.equal(summary.byCase[index].arms.cascade.verdict, "error");
      assert.equal(summary.byCase[index].arms.jevOnly.verdict, "error");
      assert.equal(summary.byCase[index].arms.kimiOnly.verdict, "pass");
      assert.equal(kimiCalls.get(index), 1);
    }
    assert.equal(summary.byCase[4].arms.cascade.verdict, "error");
    assert.equal(summary.byCase[4].arms.kimiOnly.verdict, "pass");
    assert.equal(summary.totals.actual.failedJobs, 5);
    assert.ok(!JSON.stringify(summary).includes("PRIVATE_BODY"));
    const saved = await json(
      join(data.input, "receipts/0002-jev.json.attempts"),
    );
    assert.equal(saved.journal.attempts.length, 1);
    assert.equal(saved.journal.attempts[0].error.retryable, false);
    assert.ok(!JSON.stringify(saved).includes("PRIVATE_BODY"));
    assert.deepEqual(
      await runCascade(
        { input: data.input, stage: "kimi" },
        { verifyOnly: true },
      ),
      summary,
    );
  } finally {
    await rm(data.input, { recursive: true, force: true });
  }
});

test("frozen blind labels, bands, design code and all receipts are checked before new calls", async () => {
  const data = await fixture(1);
  let calls = 0;
  try {
    const specPath = join(data.input, "evaluation-spec.json");
    const spec = await json(specPath);
    await save(specPath, {
      ...spec,
      designCodeHashes: {
        "scripts/evaluate-consolidation-cascade.ts": "0".repeat(64),
      },
    });
    await assert.rejects(
      runCascade(
        { input: data.input, stage: "jev" },
        {
          evaluateJev: async () => {
            calls++;
            return evaluation();
          },
        },
      ),
      /design code hash/,
    );
    assert.equal(calls, 0);
    await save(specPath, spec);
    await runCascade(
      { input: data.input, stage: "jev" },
      { evaluateJev: async () => evaluation() },
    );
    const reviewText = await readFile(
      join(data.input, "subagent-review.json"),
      "utf8",
    );
    data.review.candidates[0].criteria.supported_by_evidence.rationale =
      "CHANGED_LABEL";
    await save(join(data.input, "subagent-review.json"), data.review);
    const dependency = {
      evaluateKimi: async (_: unknown, criteria: ConsolidationCriterion[]) => {
        calls++;
        return kimi(criteria);
      },
    };
    await assert.rejects(
      runCascade({ input: data.input, stage: "kimi" }, dependency),
      /Frozen experiment inputs/,
    );
    await writeFile(join(data.input, "subagent-review.json"), reviewText);
    const path = join(data.input, "receipts/0001-jev.json");
    const saved = await json(path);
    saved.receipt.evaluatedAt = "2000-01-01T00:00:00.000Z";
    saved.receiptHash = cascadeHash(saved.receipt);
    await save(path, saved);
    await assert.rejects(
      runCascade({ input: data.input, stage: "kimi" }, dependency),
      /chronology/,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(data.input, { recursive: true, force: true });
  }
});

test("started attempts without receipts cannot resume or silently repeat an unknown request", async () => {
  const data = await fixture(1);
  try {
    await runCascade(
      { input: data.input, stage: "jev" },
      { evaluateJev: async () => evaluation() },
    );
    await rm(join(data.input, "summary-jev.json"));
    await rm(join(data.input, "receipts/0001-jev.json"));
    const path = join(data.input, "receipts/0001-jev.json.attempts");
    const saved = await json(path);
    saved.journal.attempts = [
      { startedAt: saved.journal.attempts[0].startedAt, outcome: "started" },
    ];
    saved.journalHash = cascadeHash(saved.journal);
    await save(path, saved);
    let calls = 0;
    await assert.rejects(
      runCascade(
        { input: data.input, stage: "jev" },
        {
          evaluateJev: async () => {
            calls++;
            return evaluation();
          },
        },
      ),
      /no duplicate request/,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(data.input, { recursive: true, force: true });
  }
});

test("predeclared raw bands, development provenance and method are checked before the first provider call", async () => {
  const data = await fixture(1);
  let calls = 0;
  try {
    const preparationPath = "scripts/prepare-consolidation-cascade.ts";
    const preparationCodeHash = hashCascadeText(
      await readFile(preparationPath),
    );
    const development = {
      cases: ["pass", "fail"].map((verdict, index) => ({
        caseId: `development-${index}`,
        inputHash: "a".repeat(64),
        source: "synthetic",
        criteria: Object.fromEntries(
          keys.map((key) => [
            key,
            {
              reference: verdict as "pass" | "fail",
              scores: Array(3).fill(index ? 0.3 : 0.9),
            },
          ]),
        ) as DevelopmentCase["criteria"],
      })),
    };
    const bands = {
      developmentHash: cascadeHash(development),
      preparationCodeHash,
      ...deriveCascadeBands(development.cases),
    };
    await save(join(data.input, "development.json"), development);
    await save(join(data.input, "method.json"), CASCADE_METHOD);
    await save(join(data.input, "bands.json"), bands);
    const bandsText = await readFile(join(data.input, "bands.json"), "utf8");
    const specPath = join(data.input, "evaluation-spec.json");
    const spec = {
      ...(await json(specPath)),
      bandsHash: hashCascadeText(bandsText),
      method: CASCADE_METHOD,
      designCodeHashes: { [preparationPath]: preparationCodeHash },
    };
    await save(specPath, spec);
    const deps = {
      evaluateJev: async () => {
        calls++;
        return evaluation();
      },
    };
    await writeFile(join(data.input, "bands.json"), `${bandsText}\n`);
    await assert.rejects(
      runCascade({ input: data.input, stage: "jev" }, deps),
      /Frozen bands hash differs/,
    );
    assert.equal(calls, 0);
    await writeFile(join(data.input, "bands.json"), bandsText);
    const changed = structuredClone(bands);
    changed.criteria.supported_by_evidence.acceptAtOrAbove = 1;
    await save(join(data.input, "bands.json"), changed);
    await save(specPath, {
      ...spec,
      bandsHash: hashCascadeText(
        await readFile(join(data.input, "bands.json")),
      ),
    });
    await assert.rejects(
      runCascade({ input: data.input, stage: "jev" }, deps),
      /development-derived criteria/,
    );
    assert.equal(calls, 0);
    await writeFile(join(data.input, "bands.json"), bandsText);
    await save(specPath, spec);
    await runCascade({ input: data.input, stage: "jev" }, deps);
    const protocol = await json(join(data.input, "protocol.json"));
    assert.ok(protocol.artifactHashes["development.json"]);
    assert.ok(protocol.artifactHashes["method.json"]);
    await save(join(data.input, "development.json"), {
      ...development,
      changed: true,
    });
    await assert.rejects(
      runCascade({ input: data.input, stage: "kimi" }, { verifyOnly: true }),
      /development hash/,
    );
    assert.equal(calls, 1);
  } finally {
    await rm(data.input, { recursive: true, force: true });
  }
});

test("a receipt surviving interruption is reused; only explicit retryable HTTP outcomes may resume", async () => {
  const data = await fixture(1);
  try {
    let count = 0;
    await runCascade(
      { input: data.input, stage: "jev" },
      {
        sleep: async () => {},
        evaluateJev: async () => {
          if (++count === 1)
            throw new GatewayRequestError("rate limit", {
              status: 429,
              retryable: true,
            });
          return evaluation();
        },
      },
    );
    const journalPath = join(data.input, "receipts/0001-jev.json.attempts");
    const saved = await json(journalPath);
    saved.journal.attempts[1] = {
      startedAt: saved.journal.attempts[1].startedAt,
      outcome: "started",
    };
    saved.journalHash = cascadeHash(saved.journal);
    await save(journalPath, saved);
    await runCascade(
      { input: data.input, stage: "jev" },
      {
        verifyOnly: true,
        evaluateJev: async () =>
          assert.fail("Saved receipt prevents duplicate"),
      },
    );
    await rm(join(data.input, "summary-jev.json"));
    await rm(join(data.input, "receipts/0001-jev.json"));
    saved.journal.attempts = saved.journal.attempts.slice(0, 1);
    saved.journalHash = cascadeHash(saved.journal);
    await save(journalPath, saved);
    await assert.rejects(
      runCascade({ input: data.input, stage: "jev" }, { verifyOnly: true }),
      /complete saved stage/,
    );
    let resumed = 0;
    const summary = await runCascade(
      { input: data.input, stage: "jev" },
      {
        evaluateJev: async () => {
          resumed++;
          return evaluation();
        },
      },
    );
    assert.equal(resumed, 1);
    assert.equal(summary.byCase[0].jev.attempts, 2);
    assert.equal(summary.totals.actual.unreportedAttemptUsage, 1);
  } finally {
    await rm(data.input, { recursive: true, force: true });
  }
});

test("fractional cost totals are identical after out-of-order completion and verified resume", async () => {
  const data = await fixture(3);
  const completionOrder: number[] = [];
  try {
    const summary = await runCascade(
      { input: data.input, stage: "jev" },
      {
        evaluateJev: async (input) => {
          const index = (input.before as { index: number }).index;
          await new Promise<void>((done) =>
            setTimeout(done, index === 0 ? 25 : 1),
          );
          completionOrder.push(index);
          return {
            ...evaluation(),
            usage: { gateway: { cost: [0.1, 0.2, 0.3][index] } },
          };
        },
      },
    );
    assert.equal(completionOrder.at(-1), 0);
    assert.equal(
      summary.totals.byCall.jev.usage.costUsd.known,
      0.1 + 0.2 + 0.3,
    );
    assert.deepEqual(
      await runCascade(
        { input: data.input, stage: "jev" },
        {
          verifyOnly: true,
          evaluateJev: async () => assert.fail("No duplicate calls"),
        },
      ),
      summary,
    );
  } finally {
    await rm(data.input, { recursive: true, force: true });
  }
});
