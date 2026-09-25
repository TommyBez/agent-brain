import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CONSOLIDATION_CRITERIA,
  CONSOLIDATION_QUESTIONS_V2,
  type ConsolidationQuestions,
} from "../lib/maintenance/consolidation-rubric";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import {
  type ConsolidationEvaluation,
  JEV_MODEL,
} from "../lib/maintenance/jev";
import {
  type DefectVariant,
  defectHash,
  defectVariants,
  hashDefectText,
  normalizeDefectRisk,
  runDefects,
} from "../scripts/evaluate-jev-defects";

const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const save = async (path: string, value: unknown) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
function evaluation(score = 0.8): ConsolidationEvaluation {
  return {
    model: JEV_MODEL,
    answers: Object.fromEntries(
      CONSOLIDATION_CRITERIA.map((key) => [key, score]),
    ),
    usage: {
      inputTokens: 10,
      outputTokens: 1,
      totalTokens: 11,
      gateway: { cost: 0.00011 },
    },
  };
}
async function fixture(calibration = 3, validation = 1) {
  const input = await mkdtemp(join(tmpdir(), "brain-jev-defects-test-"));
  const cases = Array.from({ length: calibration + validation }, (_, index) => {
    const input = {
      before: { index, text: "Fact. Fact." },
      after: "Fact.",
      evidence: ["Fact."],
      operation: "deduplicate",
    };
    return { caseId: `case-${index}`, inputHash: defectHash(input), input };
  });
  const rubric = `${JSON.stringify(CONSOLIDATION_QUESTIONS_V2, null, 2)}\n`;
  const questions = {
    positive: CONSOLIDATION_QUESTIONS_V2,
    negative: structuredClone(CONSOLIDATION_QUESTIONS_V2),
    defect: structuredClone(CONSOLIDATION_QUESTIONS_V2),
  };
  for (const arm of ["negative", "defect"] as const)
    for (const key of CONSOLIDATION_CRITERIA) {
      questions[arm][key] = {
        ...questions[arm][key],
        instructions: `${arm} synthetic question ${key}`,
        criteria: {
          true: questions[arm][key].criteria.false,
          false: questions[arm][key].criteria.true,
        },
      };
    }
  const partition = {
    cases: cases.map((item, index) => ({
      caseId: item.caseId,
      familyId: `family-${index}`,
      split: index < calibration ? "calibration" : "validation",
      source: "synthetic-new",
      variantId: index % 2 === 0 ? "good" : "bad",
    })),
  };
  await Promise.all([
    save(join(input, "cases.json"), { cases }),
    save(join(input, "subagent-review.json"), {
      reviewer: "blind-subagent",
      rubricHash: hashDefectText(rubric),
      candidates: cases.map((item, index) => ({
        caseId: item.caseId,
        inputHash: item.inputHash,
        criteria: Object.fromEntries(
          CONSOLIDATION_CRITERIA.map((key) => [
            key,
            {
              verdict: index % 2 === 0 ? "pass" : "fail",
              rationale: "BLIND_REFERENCE_DO_NOT_SEND",
            },
          ]),
        ),
      })),
    }),
    writeFile(join(input, "rubric.json"), rubric),
    save(join(input, "partition.json"), partition),
    save(join(input, "questions.json"), questions),
    save(join(input, "evaluation-spec.json"), {
      repetitions: 3,
      expectedCases: { calibration, validation },
      model: JEV_MODEL,
      designCodeHashes: {},
    }),
  ]);
  return { input, cases, questions, partition };
}
function armOf(questions: ConsolidationQuestions | undefined): DefectVariant {
  const instruction = questions?.supported_by_evidence.instructions ?? "";
  return instruction.startsWith("negative")
    ? "negative"
    : instruction.startsWith("defect")
      ? "defect"
      : "positive";
}
async function writeSelection(input: string) {
  const { selectThresholds, SELECTION_METHOD } = await import(
    "../lib/maintenance/defect-threshold-method"
  );
  const calibration = await json(join(input, "summary-calibration.json"));
  const selection = {
    version: 1,
    method: SELECTION_METHOD,
    protocolHash: calibration.protocolHash,
    calibrationSummaryHash: hashDefectText(
      await readFile(join(input, "summary-calibration.json")),
    ),
    criteria: selectThresholds(calibration.byCase),
  };
  await save(join(input, "selection.json"), selection);
  return selection;
}

test("normalizes all arms as defect risk without binary decisions or floating threshold drift", () => {
  const scores = Object.fromEntries(
    CONSOLIDATION_CRITERIA.map((key) => [key, 0.8]),
  ) as Parameters<typeof normalizeDefectRisk>[0];
  assert.equal(
    normalizeDefectRisk(scores, "positive").supported_by_evidence,
    0.2,
  );
  assert.equal(
    normalizeDefectRisk(scores, "negative").supported_by_evidence,
    0.8,
  );
  assert.equal(
    normalizeDefectRisk(scores, "defect").supported_by_evidence,
    0.8,
  );
});

test("three bounded case workers rotate arms, preserve raw scores, exclude labels and legacy decisions, resume with zero requests", async () => {
  const data = await fixture(4);
  const calls = new Map<number, string[]>();
  let active = 0,
    maxActive = 0,
    totalCalls = 0;
  try {
    const first = await runDefects(
      { input: data.input, phase: "calibration" },
      {
        evaluateJev: async (input, options) => {
          const index = (input.before as { index: number }).index,
            arm = armOf(options?.questions);
          totalCalls++;
          assert.ok(index < 4);
          assert.deepEqual(input, data.cases[index].input);
          assert.deepEqual(options, { questions: data.questions[arm] });
          assert.ok(
            !JSON.stringify([input, options]).includes("BLIND_REFERENCE"),
          );
          calls.set(index, [...(calls.get(index) ?? []), arm]);
          maxActive = Math.max(maxActive, ++active);
          await new Promise<void>((done) => setTimeout(done, 2 + (3 - index)));
          active--;
          return evaluation(0.8);
        },
      },
    );
    assert.equal(totalCalls, 36);
    assert.equal(maxActive, 3);
    assert.equal(first.uniqueCases, 4);
    for (let index = 0; index < 4; index++)
      assert.deepEqual(
        calls.get(index),
        Array.from({ length: 3 }, (_, r) =>
          Array.from(
            { length: 3 },
            (_, v) => defectVariants[(index + r + v) % 3],
          ),
        ).flat(),
      );
    for (const row of first.byCase)
      for (const arm of defectVariants)
        for (const receipt of row.receipts[arm]) {
          assert.equal(receipt.outcome, "success");
          if (receipt.outcome !== "success") continue;
          assert.equal(receipt.rawScores.supported_by_evidence, 0.8);
          assert.equal(
            receipt.risks.supported_by_evidence,
            arm === "positive" ? 0.2 : 0.8,
          );
          assert.ok(!("allowed" in receipt));
          assert.ok(
            !JSON.stringify(receipt).includes("NOT_SEMANTICALLY_VALID"),
          );
        }
    const before = await readFile(
      join(data.input, "summary-calibration.json"),
      "utf8",
    );
    const second = await runDefects(
      { input: data.input, phase: "calibration" },
      {
        verifyOnly: true,
        evaluateJev: async () => assert.fail("Resume must not call provider"),
      },
    );
    assert.deepEqual(second, first);
    assert.equal(
      await readFile(join(data.input, "summary-calibration.json"), "utf8"),
      before,
    );
    assert.equal(
      (await stat(join(data.input, "protocol.json"))).mode & 0o777,
      0o600,
    );
  } finally {
    await rm(data.input, { recursive: true, force: true });
  }
});

test("validation is isolated until complete calibration, recomputed selection is frozen, then verify-only makes no calls", async () => {
  const data = await fixture(2, 1);
  let calls = 0;
  const evaluateJev = async () => {
    calls++;
    return evaluation();
  };
  try {
    await assert.rejects(
      runDefects({ input: data.input, phase: "validation" }, { evaluateJev }),
      /requires complete calibration/,
    );
    assert.equal(calls, 0);
    const calibration = await runDefects(
      { input: data.input, phase: "calibration" },
      { evaluateJev },
    );
    assert.equal(calls, 18);
    await assert.rejects(
      runDefects({ input: data.input, phase: "validation" }, { evaluateJev }),
      /requires frozen selection/,
    );
    assert.equal(calls, 18);
    const selection = await writeSelection(data.input);
    const wrong = structuredClone(selection);
    wrong.calibrationSummaryHash = "0".repeat(64);
    await save(join(data.input, "selection.json"), wrong);
    await assert.rejects(
      runDefects({ input: data.input, phase: "validation" }, { evaluateJev }),
      /Selection does not bind/,
    );
    assert.equal(calls, 18);
    await save(join(data.input, "selection.json"), {
      ...selection,
      criteria: {},
    });
    await assert.rejects(
      runDefects({ input: data.input, phase: "validation" }, { evaluateJev }),
      /derived|selection/i,
    );
    assert.equal(calls, 18);
    await save(join(data.input, "selection.json"), selection);
    const validation = await runDefects(
      { input: data.input, phase: "validation" },
      { evaluateJev },
    );
    assert.equal(calls, 27);
    assert.equal(validation.byCase.length, 1);
    assert.equal(validation.byCase[0].caseId, "case-2");
    assert.equal(validation.protocolHash, calibration.protocolHash);
    assert.notEqual(validation.phaseHash, calibration.phaseHash);
    await runDefects(
      { input: data.input, phase: "validation" },
      {
        verifyOnly: true,
        evaluateJev: async () => assert.fail("Verification must not call"),
      },
    );
    await save(join(data.input, "selection.json"), {
      ...selection,
      afterFreeze: "changed",
    });
    await assert.rejects(
      runDefects({ input: data.input, phase: "validation" }, { evaluateJev }),
      /Frozen validation phase or selection changed/,
    );
    assert.equal(calls, 27);
  } finally {
    await rm(data.input, { recursive: true, force: true });
  }
});

test("frozen question edits and family leakage are rejected before requests", async () => {
  const data = await fixture(1, 1);
  let calls = 0;
  try {
    data.partition.cases[1].familyId = data.partition.cases[0].familyId;
    await save(join(data.input, "partition.json"), data.partition);
    await assert.rejects(
      runDefects(
        { input: data.input, phase: "calibration" },
        {
          evaluateJev: async () => {
            calls++;
            return evaluation();
          },
        },
      ),
      /Family crosses/,
    );
    assert.equal(calls, 0);
    data.partition.cases[1].familyId = "separate-family";
    await save(join(data.input, "partition.json"), data.partition);
    await runDefects(
      { input: data.input, phase: "calibration" },
      { evaluateJev: async () => evaluation() },
    );
    data.questions.defect.meaningful_improvement = {
      ...data.questions.defect.meaningful_improvement,
      instructions: "Changed question after observation",
    };
    await save(join(data.input, "questions.json"), data.questions);
    await assert.rejects(
      runDefects(
        { input: data.input, phase: "calibration" },
        {
          evaluateJev: async () => {
            calls++;
            return evaluation();
          },
        },
      ),
      /Frozen experiment/,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(data.input, { recursive: true, force: true });
  }
});

test("only explicit HTTP retries are bounded, transport errors are retained and malformed answers retain known usage", async () => {
  const data = await fixture(1, 1);
  const callCount: Record<string, number> = {};
  let slept = 0;
  try {
    const summary = await runDefects(
      { input: data.input, phase: "calibration" },
      {
        sleep: async () => {
          slept++;
        },
        evaluateJev: async (_input, options) => {
          const arm = armOf(options?.questions);
          const count = (callCount[arm] ?? 0) + 1;
          callCount[arm] = count;
          if (arm === "positive" && count <= 3)
            throw new GatewayRequestError("PRIVATE_RESPONSE_503", {
              status: 503,
              retryable: true,
            });
          if (arm === "negative" && count === 1)
            throw new GatewayRequestError("PRIVATE_TRANSPORT_TEXT", {
              retryable: true,
            });
          if (arm === "defect" && count === 1)
            return { ...evaluation(), answers: { supported_by_evidence: 5 } };
          return evaluation();
        },
      },
    );
    assert.equal(slept, 2);
    assert.equal(summary.totals.actual.requests, 11);
    assert.equal(summary.totals.actual.failedJobs, 3);
    const row = summary.byCase[0];
    assert.equal(row.receipts.positive[0].attempts, 3);
    assert.equal(row.receipts.negative[0].attempts, 1);
    assert.equal(row.receipts.defect[0].usage?.gateway?.cost, 0.00011);
    for (const arm of defectVariants)
      assert.equal(row.receipts[arm][0].outcome, "failed");
    assert.ok(!JSON.stringify(summary).includes("PRIVATE_"));
    await runDefects(
      { input: data.input, phase: "calibration" },
      {
        verifyOnly: true,
        evaluateJev: async () =>
          assert.fail("Failed outcomes must not be retried on resume"),
      },
    );
  } finally {
    await rm(data.input, { recursive: true, force: true });
  }
});

test("an interrupted unknown outcome cannot be blindly retried, but a committed success receipt survives journal-finalization interruption", async () => {
  const data = await fixture(1, 1);
  let calls = 0;
  try {
    await assert.rejects(
      runDefects(
        { input: data.input, phase: "calibration" },
        {
          evaluateJev: async () => {
            calls++;
            return evaluation();
          },
          progress: () => {
            throw new Error("Simulate interruption after committed receipt");
          },
        },
      ),
      /Simulate interruption/,
    );
    assert.equal(calls, 1);
    const receiptPath = join(
      data.input,
      "receipts",
      "calibration-0001-1-positive.json",
    );
    const saved = await readFile(receiptPath, "utf8"),
      envelope = await json(`${receiptPath}.attempts`);
    const attempt = envelope.journal.attempts[0];
    envelope.journal.attempts[0] = {
      startedAt: attempt.startedAt,
      outcome: "started",
    };
    envelope.journalHash = defectHash(envelope.journal);
    await save(`${receiptPath}.attempts`, envelope);
    await rm(receiptPath);
    await assert.rejects(
      runDefects(
        { input: data.input, phase: "calibration" },
        {
          evaluateJev: async () => {
            calls++;
            return evaluation();
          },
        },
      ),
      /Interrupted or unresolved outcome/,
    );
    assert.equal(calls, 1);
    await writeFile(receiptPath, saved);
    const resumed = await runDefects(
      { input: data.input, phase: "calibration" },
      {
        evaluateJev: async () => {
          calls++;
          return evaluation();
        },
      },
    );
    assert.equal(calls, 9);
    assert.equal(resumed.totals.actual.jobs, 9);
  } finally {
    await rm(data.input, { recursive: true, force: true });
  }
});
