import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CONSOLIDATION_QUESTIONS_V2,
  CONSOLIDATION_CRITERIA as keys,
} from "../lib/maintenance/consolidation-rubric";
import {
  JEV_CONSOLIDATION_THRESHOLDS,
  JEV_MODEL,
} from "../lib/maintenance/jev";
import { KIMI_MODEL } from "../lib/maintenance/kimi-evaluator";
import {
  assessCascade,
  cascadeConfusion,
  runCascadeAnalysis,
} from "../scripts/analyze-consolidation-cascade";
import {
  cascadeHash,
  hashCascadeText,
  runCascade,
} from "../scripts/evaluate-consolidation-cascade";

test("confusion retains uncertain, error and unevaluated outcomes without inflating false rejects", () => {
  const result = cascadeConfusion([
    { reference: "pass", decision: "pass" },
    { reference: "pass", decision: "fail" },
    { reference: "pass", decision: "uncertain" },
    { reference: "pass", decision: "error" },
    { reference: "fail", decision: "pass" },
    { reference: "fail", decision: "notEvaluated" },
    { reference: "uncertain", decision: "pass" },
  ]);
  assert.equal(result.falseNegative, 1);
  assert.equal(result.falsePositive, 1);
  assert.equal(result.uncertain, 1);
  assert.equal(result.error, 1);
  assert.equal(result.notEvaluated, 1);
  assert.equal(result.compared, 6);
  assert.equal(result.referenceUncertain, 1);
  assert.equal(result.uncertainReferenceAccepted, 1);
  assert.deepEqual(result.positiveAcceptance, { numerator: 1, denominator: 4 });
  assert.deepEqual(result.negativeAcceptance, { numerator: 1, denominator: 1 });
});

test("verified analysis audits automatic extremes, gray rescue, families and immutable outputs", async () => {
  const input = await mkdtemp(join(tmpdir(), "cascade-analysis-"));
  const save = (name: string, value: unknown) =>
    writeFile(join(input, name), JSON.stringify(value));
  try {
    const cases = Array.from({ length: 4 }, (_, index) => {
      const state = {
        before: { index },
        after: "Fact.",
        evidence: [],
        operation: "deduplicate",
      };
      return {
        caseId: `case-${index}`,
        inputHash: cascadeHash(state),
        input: state,
      };
    });
    const rubric = JSON.stringify(CONSOLIDATION_QUESTIONS_V2);
    const bands = {
      developmentCases: 98,
      observationsPerCase: 3,
      margin: 0.05,
      criteria: Object.fromEntries(
        keys.map((key) => [key, { rejectBelow: 0.2, acceptAtOrAbove: 0.9 }]),
      ),
    };
    await Promise.all([
      save("cases.json", { cases }),
      save("bands.json", bands),
      writeFile(join(input, "rubric.json"), rubric),
      save("evaluation-spec.json", {
        repetitions: 1,
        expectedCases: 4,
        designCodeHashes: {},
      }),
      save("partition.json", {
        cases: cases.map((item, index) => ({
          caseId: item.caseId,
          familyId: index < 2 ? "a" : "b",
          variantId: `variant-${index}`,
          targetCriterion:
            index < 2
              ? "preserves_distinct_information"
              : index === 3
                ? "supported_by_evidence"
                : null,
        })),
      }),
      save("subagent-review.json", {
        reviewer: "blind-subagent",
        rubricHash: hashCascadeText(rubric),
        candidates: cases.map((item, index) => ({
          caseId: item.caseId,
          inputHash: item.inputHash,
          criteria: Object.fromEntries(
            keys.map((key) => [
              key,
              {
                verdict:
                  index < 2 && key === "preserves_distinct_information"
                    ? "fail"
                    : index === 3 && key === "supported_by_evidence"
                      ? "uncertain"
                      : "pass",
                rationale: "Frozen independent rationale.",
              },
            ]),
          ),
        })),
      }),
      save("kimi-preflight.json", {
        result: {
          usage: {
            costUsd: 0.001,
            inputTokens: 1,
            outputTokens: 1,
            cachedInputTokens: 0,
          },
        },
      }),
    ]);
    await assert.rejects(runCascadeAnalysis(input), /complete saved stage/);
    await assert.rejects(readFile(join(input, "analysis.json")), {
      code: "ENOENT",
    });
    await runCascade(
      { input, stage: "jev" },
      {
        evaluateJev: async (state) => {
          const index = (state.before as { index: number }).index;
          const answers = Object.fromEntries(
            keys.map((key) => [
              key,
              index === 0 && key === "preserves_distinct_information"
                ? 0.1
                : index !== 1 && key === "supported_by_evidence"
                  ? 0.5
                  : 0.95,
            ]),
          );
          return {
            model: JEV_MODEL,
            answers,
            allowed: keys.every(
              (key) => answers[key] >= JEV_CONSOLIDATION_THRESHOLDS[key],
            ),
            usage: { gateway: { cost: 0.001 } },
            reasons: [],
          };
        },
      },
    );
    const summary = await runCascade(
      { input, stage: "kimi" },
      {
        evaluateKimi: async (state, criteria) => {
          const index = (state.before as { index: number }).index;
          return {
            model: KIMI_MODEL,
            responseModel: null,
            responseId: null,
            judgments: Object.fromEntries(
              criteria.map((key) => [
                key,
                {
                  verdict:
                    index === 1 && key === "preserves_distinct_information"
                      ? "fail"
                      : index === 3 && criteria.length === 1
                        ? "uncertain"
                        : "pass",
                  rationale: "Model rationale.",
                },
              ]),
            ),
            latencyMs: 2,
            usage: {
              inputTokens: 100,
              outputTokens: 10,
              totalTokens: 110,
              reasoningTokens: 0,
              cachedInputTokens: 20,
              costUsd: 0.004,
            },
          };
        },
      },
    );
    const assessment = assessCascade(
      summary,
      bands as Parameters<typeof assessCascade>[1],
    );
    assert.equal(assessment.overall.cascade.falsePositive, 1);
    assert.equal(assessment.overall.cascade.truePositive, 1);
    assert.equal(assessment.overall.cascade.uncertain, 1);
    assert.equal(
      assessment.criteria.supported_by_evidence.cascade.notEvaluated,
      1,
    );
    assert.equal(
      assessment.criteria.supported_by_evidence.cascade.uncertain,
      1,
    );
    assert.equal(assessment.autoAudit.green.vsReference.falsePositive, 1);
    assert.deepEqual(assessment.autoAudit.green.baselineDisagreements, [
      "case-1",
    ]);
    assert.deepEqual(assessment.recovery.grayResolved, ["case-2"]);
    assert.deepEqual(assessment.recovery.families, ["b"]);
    assert.equal(assessment.intentDiscrepancies.length, 1);
    assert.equal(assessment.intentDiscrepancies[0].caseId, "case-3");
    assert.equal(assessment.cost.operational.cascade.jobs, 6);
    assert.equal(assessment.cost.experiment.jobs, 10);
    const missingCost = structuredClone(summary);
    missingCost.totals.byArm.kimiOnly.usage.costUsd.missingJobs = 1;
    const incomplete = assessCascade(
      missingCost,
      bands as Parameters<typeof assessCascade>[1],
    );
    assert.equal(incomplete.cost.cascadeMinusAllKimiUsd, null);
    assert.equal(incomplete.cost.relativeCascadeSaving, null);
    const analysis = await runCascadeAnalysis(input);
    assert.ok(Math.abs(analysis.allInRecordedCostUsd - 0.029) < 1e-12);
    const report = await readFile(join(input, "rapporto.md"), "utf8");
    assert.match(report, /varianti correlate/);
    assert.match(report, /non rappresentano giudizi incerti di Kimi/);
    assert.match(report, /cache del batch/);
    assert.match(report, /Costo complessivo registrato/);
    assert.ok(analysis.timings.experiment.elapsedIntervalMs !== null);
    assert.deepEqual(await runCascadeAnalysis(input), analysis);
    await writeFile(join(input, "rapporto.md"), "altered");
    await assert.rejects(runCascadeAnalysis(input), /immutable output/);
  } finally {
    await rm(input, { recursive: true, force: true });
  }
});
