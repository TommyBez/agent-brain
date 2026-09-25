import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  analyzeCases,
  analyzeDirectory,
  CRITERIA,
  compareVector,
  familyPartition,
  overallLabel,
  type PairedCase,
  scoreDistributions,
  selectThreshold,
} from "../scripts/analyze-consolidation-paired";

const thresholds = {
  supported_by_evidence: 0.9,
  preserves_distinct_information: 0.9,
  no_new_human_action: 0.9,
  meaningful_improvement: 0.8,
};

test("score distributions keep labels separate, compute even/odd medians and mark absent classes", () => {
  const points = [
    { label: "pass" as const, probability: 0.9 },
    { label: "fail" as const, probability: 0.7 },
    { label: "pass" as const, probability: 0.5 },
    { label: "fail" as const, probability: 0.3 },
    { label: "pass" as const, probability: 0.8 },
  ];
  const before = structuredClone(points);
  const distributions = scoreDistributions(points);
  assert.deepEqual(distributions.pass, {
    count: 3,
    min: 0.5,
    median: 0.8,
    max: 0.9,
  });
  assert.deepEqual(distributions.fail, {
    count: 2,
    min: 0.3,
    median: 0.5,
    max: 0.7,
  });
  assert.deepEqual(distributions.uncertain, {
    count: 0,
    min: null,
    median: null,
    max: null,
  });
  assert.deepEqual(points, before);
  const analyzed = analyzeCases(
    [
      item("same-family", "pass", 0.8),
      item("same-family", "fail", 0.7, "variant"),
    ],
    thresholds,
  );
  assert.equal(
    analyzed.scoreDistributions.supported_by_evidence.pass.median,
    0.8,
  );
  assert.equal(
    analyzed.families[0].scoreDistributions.supported_by_evidence.fail.median,
    0.7,
  );
});
function item(
  familyId: string,
  verdict: "pass" | "fail" | "uncertain",
  probability: number,
  id = familyId,
): PairedCase {
  return {
    pass: 1,
    candidateId: id,
    inputHash: id,
    familyId,
    criteria: Object.fromEntries(
      CRITERIA.map((criterion) => [
        criterion,
        { verdict, rationale: "Fixture evidence." },
      ]),
    ) as PairedCase["criteria"],
    scores: Object.fromEntries(
      CRITERIA.map((criterion) => [criterion, probability]),
    ) as PairedCase["scores"],
  };
}

test("threshold fitting needs both known classes and excludes uncertain labels", () => {
  const noNegative = selectThreshold([
    { label: "pass", probability: 0.85 },
    { label: "uncertain", probability: 0.99 },
  ]);
  assert.equal(noNegative.status, "unsupported");
  assert.equal(noNegative.negatives, 0);
  const fitted = selectThreshold([
    { label: "pass", probability: 0.8 },
    { label: "pass", probability: 0.9 },
    { label: "fail", probability: 0.6 },
    { label: "uncertain", probability: 0.99 },
  ]);
  assert.equal(fitted.status, "exploratory_candidate");
  if (fitted.status !== "exploratory_candidate") return;
  assert.equal(fitted.selected.threshold, 0.8);
  assert.equal(fitted.selected.passApproved, 2);
  assert.equal(fitted.selected.failApproved, 0);
  assert.equal(fitted.uncertainExcluded, 1);
});

test("overlapping scores cannot create an unsupported safe threshold by approving nobody", () => {
  assert.equal(
    selectThreshold([
      { label: "pass", probability: 0.8 },
      { label: "fail", probability: 0.9 },
    ]).status,
    "unsupported",
  );
  assert.equal(
    selectThreshold([
      { label: "pass", probability: 1 },
      { label: "fail", probability: 1 },
    ]).status,
    "unsupported",
  );
});

test("overall uncertain blocks approval while remaining distinct from a known fail", () => {
  const uncertain = item("family", "pass", 0.99);
  uncertain.criteria.preserves_distinct_information.verdict = "uncertain";
  assert.equal(overallLabel(uncertain), "uncertain");
  const counts = compareVector([uncertain], thresholds);
  assert.equal(counts.uncertainApproved, 1);
  assert.equal(counts.failApproved, 0);
  uncertain.criteria.supported_by_evidence.verdict = "fail";
  assert.equal(overallLabel(uncertain), "fail");
});

test("family-heldout labels do not affect threshold selection and unsafe validation never promotes", () => {
  const names = Array.from({ length: 100 }, (_, index) => `family-${index}`);
  const exploratory = names.filter(
    (name) => familyPartition(name) === "exploratory",
  );
  const heldout = names.filter((name) => familyPartition(name) === "heldout");
  const cases = [
    item(exploratory[0], "pass", 0.8, "explore-positive"),
    item(exploratory[1], "fail", 0.6, "explore-negative"),
    item(heldout[0], "fail", 0.99, "heldout-negative"),
    item(heldout[1], "pass", 0.95, "heldout-positive"),
    item(heldout[1], "pass", 0.95, "heldout-positive-variant"),
  ];
  const result = analyzeCases(cases, thresholds);
  assert.equal(result.calibration.candidateVector?.supported_by_evidence, 0.8);
  assert.equal(result.calibration.status, "unsafe_on_heldout");
  assert.equal(result.calibration.heldout?.overall?.failApproved, 1);
  assert.equal(result.calibration.promoted, false);
  assert.equal(result.dependence.heldoutFamilies, 2);
  assert.equal(result.dependence.heldoutProposals, 3);
  assert.equal(
    result.families.find((family) => family.familyId === heldout[1])?.proposals,
    2,
  );
  assert.equal(result.sensitivity.length, 4);
  assert.ok(result.sensitivity.every((vector) => vector.recommended === false));
});

test("analysis refuses an incomplete experiment before opening score-bearing files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paired-analysis-"));
  try {
    await writeFile(
      join(directory, "evaluation-spec.json"),
      JSON.stringify({ passes: 20, generator: "test", thresholds }),
    );
    await writeFile(
      join(directory, "summary.json"),
      JSON.stringify({ status: "awaiting_review", passes: 1 }),
    );
    await writeFile(
      join(directory, "pass-01.json"),
      "invalid score-bearing JSON that must not be opened",
    );
    await assert.rejects(
      analyzeDirectory(directory),
      /do not unblind an active run/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("completed receipts produce cost-aware private reports and detect edited blind reviews", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paired-analysis-complete-"));
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const hash = (value: unknown) => sha(JSON.stringify(value));
  const save = (name: string, value: unknown) =>
    writeFile(join(directory, name), JSON.stringify(value));
  try {
    const spec = {
      passes: 1,
      generator: "deepseek/deepseek-v4.1-flash",
      thresholds,
    };
    await save("evaluation-spec.json", spec);
    await save("protocol.json", { evaluationSpecHash: hash(spec), thresholds });
    await save("summary.json", { status: "completed", passes: 1 });
    const input = { before: "Fact. Fact.", after: "Fact." };
    const inputHash = hash(input);
    const reference = item("duplication", "pass", 0.99, "candidate-1");
    const assistant = {
      candidateId: reference.candidateId,
      inputHash,
      familyId: reference.familyId,
      criteria: reference.criteria,
    };
    const review = { pass: 1, reviewer: "assistant", candidates: [assistant] };
    const reviewHash = hash(review);
    const generation = { pass: 1, generated: {} };
    const request = {
      pass: 1,
      candidates: [{ candidateId: reference.candidateId, inputHash, input }],
    };
    const frozenAt = "2026-09-17T10:00:00.000Z";
    const frozen = {
      pass: 1,
      requestHash: hash(request),
      reviewHash,
      frozenAt,
    };
    const jev = {
      allowed: true,
      answers: reference.scores,
      usage: {
        inputTokens: 100,
        outputTokens: 0,
        gateway: { cost: 0.002, marketCost: 0.003 },
      },
    };
    const evaluations = {
      [reference.candidateId]: {
        inputHash,
        reviewHash,
        evaluatedAt: "2026-09-17T10:00:01.000Z",
        result: jev,
      },
    };
    await save("generation-01.json", generation);
    await save("blind-request-01.json", request);
    await save("assistant-review-01.json", review);
    await save("review-frozen-01.json", frozen);
    await save("jev-evaluations-01.json", evaluations);
    await save("pass-01.json", {
      pass: 1,
      status: "completed",
      proposed: 1,
      applied: 1,
      validationRejected: 0,
      schemaRejected: 0,
      generationFault: null,
      usage: { inputTokens: 1000, outputTokens: 100 },
      reviewHash,
      requestHash: hash(request),
      generationHash: hash(generation),
      evaluationsHash: hash(evaluations),
      reviewFrozenAt: frozenAt,
      decisions: [
        {
          candidateId: reference.candidateId,
          inputHash,
          assistant,
          assistantWouldPass: true,
          jev,
          accepted: true,
        },
      ],
    });
    const report = await analyzeDirectory(directory);
    assert.equal(report.comparedProposals, 1);
    assert.equal(report.costs.jev.recordedUsd, 0.002);
    assert.equal(report.costs.jev.missingCostReceipts, 0);
    assert.ok(
      Math.abs((report.costs.generator.estimatedUsd ?? 0) - 0.00042) < 1e-12,
    );
    assert.equal(
      (await stat(join(directory, "analysis.json"))).mode & 0o777,
      0o600,
    );
    assert.match(
      await readFile(join(directory, "analysis.md"), "utf8"),
      /1 passaggi, 1 proposte/,
    );
    await writeFile(
      join(directory, "assistant-review-01.json"),
      `${JSON.stringify(review)}\n`,
    );
    await assert.rejects(
      analyzeDirectory(directory),
      /Frozen assistant review changed/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
