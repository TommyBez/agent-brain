import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONSOLIDATION_QUESTIONS_V2 } from "../lib/maintenance/consolidation-rubric";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import {
  JEV_CONSOLIDATION_THRESHOLDS,
  JEV_MODEL,
} from "../lib/maintenance/jev";
import {
  controlledCriteria,
  controlledHash,
  hashControlledText,
  runControlled,
} from "../scripts/evaluate-jev-controlled";

const keys = controlledCriteria;
function evaluation(score = 0.95) {
  return {
    model: JEV_MODEL,
    answers: Object.fromEntries(keys.map((key) => [key, score])),
    usage: { gateway: { cost: 0.001 } },
  };
}
async function json(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}
async function save(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value));
}
async function fixture() {
  const input = await mkdtemp(join(tmpdir(), "brain-controlled-"));
  const cases = Array.from({ length: 4 }, (_, index) => {
    const input = {
      before: { index, text: "Fact. Fact." },
      after: "Fact.",
      evidence: [],
      operation: "deduplicate",
    };
    return { caseId: `case-${index}`, inputHash: controlledHash(input), input };
  });
  const partition = {
    cases: cases.map((item, index) => ({
      caseId: item.caseId,
      familyId: index < 2 ? "family-a" : "family-b",
      variantId: index % 2 ? "unsupported" : "good",
      targetCriterion: index % 2 ? "supported_by_evidence" : null,
      split: index < 2 ? "calibration" : "validation",
    })),
  };
  const rubricText = `${JSON.stringify(CONSOLIDATION_QUESTIONS_V2, null, 2)}\n`;
  const review = {
    reviewer: "blind-subagent",
    rubricHash: hashControlledText(rubricText),
    candidates: cases.map((item) => ({
      caseId: item.caseId,
      inputHash: item.inputHash,
      criteria: Object.fromEntries(
        keys.map((key) => [
          key,
          { verdict: "pass", rationale: "Synthetic supported consolidation." },
        ]),
      ),
    })),
  };
  await Promise.all([
    save(join(input, "cases.json"), { cases }),
    save(join(input, "partition.json"), partition),
    save(join(input, "subagent-review.json"), review),
    writeFile(join(input, "rubric.json"), rubricText),
    save(join(input, "evaluation-spec.json"), {
      repetitions: 3,
      cases: 4,
      model: JEV_MODEL,
      thresholds: JEV_CONSOLIDATION_THRESHOLDS,
    }),
  ]);
  return { input, cases, partition, review };
}
async function select(input: string, protocolHash: string) {
  await save(join(input, "calibration.json"), {
    protocolHash,
    thresholds: {
      ...JEV_CONSOLIDATION_THRESHOLDS,
      supported_by_evidence: 0.99,
    },
    selectionRule: "Synthetic frozen calibration-only rule",
  });
}

test("calibration sends only its families, V2 questions and three serial repeats; complete resume makes zero new calls", async () => {
  const fixtureData = await fixture();
  const order: number[] = [];
  let active = 0;
  try {
    const evaluate = async (
      input: { before: unknown },
      options: { questions: unknown },
    ) => {
      assert.equal(++active, 1);
      assert.equal(options.questions, CONSOLIDATION_QUESTIONS_V2);
      const protocol = await json(join(fixtureData.input, "protocol.json"));
      assert.ok(protocol.artifactHashes["partition.json"]);
      assert.ok(protocol.artifactHashes["evaluation-spec.json"]);
      assert.equal(Object.keys(protocol.codeHashes).length, 7);
      assert.ok(protocol.codeHashes["lib/maintenance/consolidation-policy.ts"]);
      assert.ok(protocol.codeHashes["package.json"]);
      assert.ok(protocol.codeHashes["pnpm-lock.yaml"]);
      const index = (input.before as { index: number }).index;
      order.push(index);
      active--;
      return evaluation(order.length === 2 ? 0.5 : 0.95);
    };
    const summary = await runControlled(
      { input: fixtureData.input, phase: "calibration" },
      { evaluate },
    );
    assert.deepEqual(order, [0, 0, 0, 1, 1, 1]);
    assert.equal(summary.uniqueFamilies, 1);
    assert.equal(summary.evaluations, 6);
    assert.deepEqual(
      summary.byCase[0].criteria.supported_by_evidence.scores,
      [0.95, 0.5, 0.95],
    );
    assert.deepEqual(summary.byCase[0].decisions, [true, false, true]);
    assert.equal(summary.byCase[0].passCount, 2);
    assert.ok(Math.abs(summary.cost.known - 0.006) < 1e-10);
    assert.deepEqual(
      await runControlled(
        { input: fixtureData.input, phase: "calibration" },
        { evaluate },
      ),
      summary,
    );
    assert.equal(order.length, 6);
  } finally {
    await rm(fixtureData.input, { recursive: true, force: true });
  }
});

test("validation requires completed calibration and freezes selected thresholds before heldout calls", async () => {
  const { input } = await fixture();
  let calls = 0;
  try {
    await assert.rejects(
      runControlled(
        { input, phase: "validation" },
        {
          evaluate: async () => {
            calls++;
            return evaluation();
          },
        },
      ),
      /frozen calibration.json/,
    );
    assert.equal(calls, 0);
    const calibration = await runControlled(
      { input, phase: "calibration" },
      { evaluate: async () => evaluation() },
    );
    await select(input, calibration.protocolHash);
    const summary = await runControlled(
      { input, phase: "validation" },
      {
        evaluate: async (item) => {
          calls++;
          assert.ok((item.before as { index: number }).index >= 2);
          const frozen = await json(join(input, "validation-protocol.json"));
          assert.equal(frozen.protocolHash, calibration.protocolHash);
          assert.equal(frozen.thresholds.supported_by_evidence, 0.99);
          assert.equal(
            frozen.calibrationHash,
            hashControlledText(
              await readFile(join(input, "calibration.json"), "utf8"),
            ),
          );
          return evaluation();
        },
      },
    );
    assert.equal(calls, 6);
    assert.deepEqual(summary.byCase[0].decisions, [true, true, true]);
    assert.deepEqual(summary.byCase[0].calibratedDecisions, [
      false,
      false,
      false,
    ]);
    await runControlled(
      { input, phase: "validation" },
      {
        evaluate: async () => {
          calls++;
          return evaluation();
        },
      },
    );
    assert.equal(calls, 6);
    await select(input, "0".repeat(64));
    await assert.rejects(
      runControlled(
        { input, phase: "validation" },
        {
          evaluate: async () => {
            calls++;
            return evaluation();
          },
        },
      ),
      /another frozen protocol/,
    );
    assert.equal(calls, 6);
  } finally {
    await rm(input, { recursive: true, force: true });
  }
});

test("family leakage, mismatched review and case hashes are rejected before any evaluation", async () => {
  const data = await fixture();
  let calls = 0;
  const dependencies = {
    evaluate: async () => {
      calls++;
      return evaluation();
    },
  };
  try {
    const leaking = structuredClone(data.partition);
    leaking.cases[2].familyId = leaking.cases[0].familyId;
    await save(join(data.input, "partition.json"), leaking);
    await assert.rejects(
      runControlled({ input: data.input, phase: "calibration" }, dependencies),
      /families must be disjoint/,
    );
    await save(join(data.input, "partition.json"), data.partition);
    const changedReview = structuredClone(data.review);
    changedReview.candidates[1] = changedReview.candidates[0];
    await save(join(data.input, "subagent-review.json"), changedReview);
    await assert.rejects(
      runControlled({ input: data.input, phase: "calibration" }, dependencies),
      /review membership/,
    );
    await save(join(data.input, "subagent-review.json"), data.review);
    data.cases[0].input.after = "Altered";
    await save(join(data.input, "cases.json"), { cases: data.cases });
    await assert.rejects(
      runControlled({ input: data.input, phase: "calibration" }, dependencies),
      /input hash differs/,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(data.input, { recursive: true, force: true });
  }
});

test("partial resume rejects artifact or receipt tampering before adding any calls", async () => {
  const { input } = await fixture();
  let calls = 0;
  const evaluate = async () => {
    calls++;
    return evaluation();
  };
  try {
    await assert.rejects(
      runControlled(
        { input, phase: "calibration" },
        {
          evaluate,
          progress: () => {
            throw new Error("Pause after durable receipt");
          },
        },
      ),
      /Pause/,
    );
    assert.equal(calls, 1);
    for (const name of [
      "partition.json",
      "evaluation-spec.json",
      "subagent-review.json",
    ]) {
      const path = join(input, name);
      const original = await readFile(path, "utf8");
      await writeFile(path, `${original}\n`);
      await assert.rejects(
        runControlled({ input, phase: "calibration" }, { evaluate }),
        /Frozen experiment inputs/,
      );
      assert.equal(calls, 1);
      await writeFile(path, original);
    }
    const path = join(input, "receipts", "calibration", "0001.json");
    const original = await readFile(path, "utf8");
    const receipt = JSON.parse(original);
    receipt.receipt.result.answers.supported_by_evidence = 0.91;
    await save(path, receipt);
    await assert.rejects(
      runControlled({ input, phase: "calibration" }, { evaluate }),
      /receipt hash differs/,
    );
    assert.equal(calls, 1);
    await writeFile(path, original);
    await runControlled({ input, phase: "calibration" }, { evaluate });
    assert.equal(calls, 6);
  } finally {
    await rm(input, { recursive: true, force: true });
  }
});

test("unknown interrupted attempts and invalid chronology abort without duplicate requests", async () => {
  const { input } = await fixture();
  let calls = 0;
  const evaluate = async () => {
    calls++;
    return evaluation();
  };
  try {
    await assert.rejects(
      runControlled(
        { input, phase: "calibration" },
        {
          evaluate,
          progress: () => {
            throw new Error("Pause");
          },
        },
      ),
    );
    const receiptPath = join(input, "receipts", "calibration", "0001.json");
    const journalPath = `${receiptPath}.attempts`;
    const originalJournal = await json(journalPath);
    const receipt = await json(receiptPath);
    receipt.receipt.evaluatedAt = "2000-01-01T00:00:00.000Z";
    receipt.receiptHash = controlledHash(receipt.receipt);
    await save(receiptPath, receipt);
    await assert.rejects(
      runControlled({ input, phase: "calibration" }, { evaluate }),
      /chronology/,
    );
    await rm(receiptPath);
    originalJournal.journal.attempts[0] = {
      startedAt: originalJournal.journal.attempts[0].startedAt,
      outcome: "started",
    };
    originalJournal.journalHash = controlledHash(originalJournal.journal);
    await save(journalPath, originalJournal);
    await assert.rejects(
      runControlled({ input, phase: "calibration" }, { evaluate }),
      /interrupted/,
    );
    assert.equal(calls, 1);
  } finally {
    await rm(input, { recursive: true, force: true });
  }
});

test("retryable errors have bounded sanitized journals and a successful retry stays resumable", async () => {
  const { input } = await fixture();
  let calls = 0;
  try {
    const summary = await runControlled(
      { input, phase: "calibration" },
      {
        evaluate: async () => {
          calls++;
          if (calls === 1)
            throw new GatewayRequestError("Sensitive provider response", {
              retryable: true,
              status: 429,
            });
          return evaluation();
        },
        sleep: async () => undefined,
      },
    );
    assert.equal(calls, 7);
    assert.equal(summary.attempts, 7);
    const text = await readFile(
      join(input, "receipts", "calibration", "0001.json.attempts"),
      "utf8",
    );
    assert.ok(!text.includes("Sensitive"));
    assert.equal(JSON.parse(text).journal.attempts[0].status, 429);
    await runControlled(
      { input, phase: "calibration" },
      {
        evaluate: async () => {
          throw new Error("Must not call");
        },
      },
    );
  } finally {
    await rm(input, { recursive: true, force: true });
  }
  const failing = await fixture();
  let failures = 0;
  try {
    const dependencies = {
      evaluate: async () => {
        failures++;
        throw new GatewayRequestError("Private text", {
          retryable: true,
          status: 503,
        });
      },
      sleep: async () => undefined,
    };
    await assert.rejects(
      runControlled(
        { input: failing.input, phase: "calibration" },
        dependencies,
      ),
      /sanitized/,
    );
    assert.equal(failures, 3);
    await assert.rejects(
      runControlled(
        { input: failing.input, phase: "calibration" },
        dependencies,
      ),
      /attempt limit/,
    );
    assert.equal(failures, 3);
  } finally {
    await rm(failing.input, { recursive: true, force: true });
  }
});

test("verification only requires complete receipts and validates additional frozen design code", async () => {
  const { input } = await fixture();
  let calls = 0;
  const evaluate = async () => {
    calls++;
    return evaluation();
  };
  try {
    const specPath = join(input, "evaluation-spec.json");
    const spec = await json(specPath);
    const designPath = "tests/jev-controlled.test.ts";
    spec.designCodeHashes = {
      [designPath]: hashControlledText(
        await readFile(join(process.cwd(), designPath)),
      ),
    };
    await save(specPath, spec);
    await assert.rejects(
      runControlled(
        { input, phase: "calibration" },
        { evaluate, verifyOnly: true },
      ),
      /Verification requires complete saved receipts/,
    );
    assert.equal(calls, 0);
    const summary = await runControlled(
      { input, phase: "calibration" },
      { evaluate },
    );
    assert.equal(calls, 6);
    assert.deepEqual(
      await runControlled(
        { input, phase: "calibration" },
        { evaluate, verifyOnly: true },
      ),
      summary,
    );
    assert.equal(calls, 6);
    spec.designCodeHashes[designPath] = "0".repeat(64);
    await save(specPath, spec);
    await assert.rejects(
      runControlled(
        { input, phase: "calibration" },
        { evaluate, verifyOnly: true },
      ),
      /design code hash differs/,
    );
    assert.equal(calls, 6);
  } finally {
    await rm(input, { recursive: true, force: true });
  }
});

test("strict validation binds the selection to verified calibration scores, source and rule", async () => {
  const { input } = await fixture();
  let heldoutCalls = 0;
  try {
    const { CONTROLLED_SELECTION_RULE, selectControlledThresholds } =
      await import("../scripts/analyze-jev-controlled");
    const analyzerPath = "scripts/analyze-jev-controlled.ts";
    const analyzerHash = hashControlledText(
      await readFile(join(process.cwd(), analyzerPath)),
    );
    const spec = await json(join(input, "evaluation-spec.json"));
    Object.assign(spec, {
      designCodeHashes: { [analyzerPath]: analyzerHash },
      selectionRule: CONTROLLED_SELECTION_RULE,
      independentFamilies: 2,
      calibrationFamilies: 1,
      validationFamilies: 1,
    });
    await save(join(input, "evaluation-spec.json"), spec);
    const calibration = await runControlled(
      { input, phase: "calibration" },
      { evaluate: async () => evaluation() },
    );
    const selection = {
      protocolHash: calibration.protocolHash,
      selectedAt: new Date().toISOString(),
      calibrationSummaryHash: hashControlledText(
        await readFile(join(input, "summary-calibration.json"), "utf8"),
      ),
      analysisCodeHash: analyzerHash,
      ...selectControlledThresholds(calibration.byCase),
    };
    const dependencies = {
      evaluate: async () => {
        heldoutCalls++;
        return evaluation();
      },
    };
    await save(join(input, "calibration.json"), {
      ...selection,
      thresholds: JEV_CONSOLIDATION_THRESHOLDS,
    });
    await assert.rejects(
      runControlled({ input, phase: "validation" }, dependencies),
      /calibration-only selection rule/,
    );
    assert.equal(heldoutCalls, 0);
    await save(join(input, "calibration.json"), {
      ...selection,
      calibrationSummaryHash: "0".repeat(64),
    });
    await assert.rejects(
      runControlled({ input, phase: "validation" }, dependencies),
      /summary, analysis code, rule or chronology/,
    );
    assert.equal(heldoutCalls, 0);
    await save(join(input, "calibration.json"), selection);
    await runControlled({ input, phase: "validation" }, dependencies);
    assert.equal(heldoutCalls, 6);
  } finally {
    await rm(input, { recursive: true, force: true });
  }
});
