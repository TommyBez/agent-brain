import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  CONSOLIDATION_CRITERIA,
  type ConsolidationCriterion,
} from "../lib/maintenance/consolidation-rubric";
import { JEV_CONSOLIDATION_THRESHOLDS } from "../lib/maintenance/jev";
import { runControlled } from "./evaluate-jev-controlled";

type Verdict = "pass" | "fail" | "uncertain";
type Thresholds = Record<ConsolidationCriterion, number>;
export type ControlledCase = {
  caseId: string;
  familyId: string;
  variantId: string;
  targetCriterion: ConsolidationCriterion | null;
  reference: Verdict;
  criteria: Record<
    ConsolidationCriterion,
    { reference: Verdict; scores: number[] }
  >;
};
const keys = CONSOLIDATION_CRITERIA;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export const CONTROLLED_SELECTION_RULE = {
  grid: "0.00 to 1.00 inclusive, steps of 0.01; score >= threshold passes",
  selection:
    "For each criterion choose the smallest grid threshold with zero reference-negative passes in ANY calibration repetition. Never use validation scores. If none exists retain 1.00 and mark selection infeasible.",
  uncertain:
    "Exclude uncertain criterion labels from fitting and criterion confusion; an overall fail takes precedence over uncertainty, otherwise any uncertainty makes the overall reference uncertain.",
  qualification:
    "Exploratory feasibility only: each criterion needs >=6 distinct positive and >=6 distinct negative calibration cases, zero negative passes in any repeat and >=50% of positives passing all three repeats; the overall gate also needs >=50% of reference positives passing all three and zero negative passes in any repeat.",
  validation:
    "Freeze this one selection before any validation API call. Measure validation once without refitting, even if calibration failed the exploratory feasibility screen; that failure remains a failure. No production promotion from this small synthetic experiment.",
  unit: "Case, grouped into disjoint document families. Three API repetitions are technical stability measures, not three independent examples.",
} as const;

function validateCases(cases: ControlledCase[]) {
  if (
    !cases.length ||
    new Set(cases.map((item) => item.caseId)).size !== cases.length
  )
    throw new Error("Missing or duplicate controlled cases.");
  for (const item of cases) {
    if (!["pass", "fail", "uncertain"].includes(item.reference))
      throw new Error("Invalid reference.");
    for (const key of keys) {
      const criterion = item.criteria[key];
      if (
        !criterion ||
        !["pass", "fail", "uncertain"].includes(criterion.reference) ||
        criterion.scores.length !== 3 ||
        criterion.scores.some(
          (score) => !Number.isFinite(score) || score < 0 || score > 1,
        )
      )
        throw new Error("Incomplete or invalid scores/reference.");
    }
    const labels = keys.map((key) => item.criteria[key].reference);
    const expected = labels.includes("fail")
      ? "fail"
      : labels.includes("uncertain")
        ? "uncertain"
        : "pass";
    if (item.reference !== expected)
      throw new Error("Overall reference differs from criterion labels.");
  }
}

export function auc(positive: number[], negative: number[]) {
  if (!positive.length || !negative.length) return null;
  let favorable = 0;
  for (const good of positive)
    for (const bad of negative)
      favorable += good > bad ? 1 : good === bad ? 0.5 : 0;
  return favorable / (positive.length * negative.length);
}
const median = (scores: number[]) => [...scores].sort((a, b) => a - b)[1];

function confusion(items: Array<{ reference: Verdict; allowed: boolean }>) {
  return {
    truePositive: items.filter((v) => v.reference === "pass" && v.allowed)
      .length,
    falseNegative: items.filter((v) => v.reference === "pass" && !v.allowed)
      .length,
    falsePositive: items.filter((v) => v.reference === "fail" && v.allowed)
      .length,
    trueNegative: items.filter((v) => v.reference === "fail" && !v.allowed)
      .length,
    uncertain: items.filter((v) => v.reference === "uncertain").length,
    uncertainAccepted: items.filter(
      (v) => v.reference === "uncertain" && v.allowed,
    ).length,
  };
}

function outcome(items: Array<{ reference: Verdict; passes: boolean[] }>) {
  return {
    reference: {
      pass: items.filter((v) => v.reference === "pass").length,
      fail: items.filter((v) => v.reference === "fail").length,
      uncertain: items.filter((v) => v.reference === "uncertain").length,
    },
    perRepeat: [0, 1, 2].map((repeat) =>
      confusion(
        items.map((v) => ({
          reference: v.reference,
          allowed: v.passes[repeat],
        })),
      ),
    ),
    descriptiveAll3: confusion(
      items.map((v) => ({
        reference: v.reference,
        allowed: v.passes.every(Boolean),
      })),
    ),
    descriptiveAny: confusion(
      items.map((v) => ({
        reference: v.reference,
        allowed: v.passes.some(Boolean),
      })),
    ),
    flips: items.filter(
      (v) => v.passes.some(Boolean) && !v.passes.every(Boolean),
    ).length,
  };
}

export function assessControlled(
  cases: ControlledCase[],
  thresholds: Thresholds,
) {
  validateCases(cases);
  const criteria = Object.fromEntries(
    keys.map((key) => {
      const positives = cases.filter(
        (v) => v.criteria[key].reference === "pass",
      );
      const negatives = cases.filter(
        (v) => v.criteria[key].reference === "fail",
      );
      const pairs = cases
        .filter((v) => v.targetCriterion === key)
        .map((bad) => {
          const good = cases.find(
            (v) => v.familyId === bad.familyId && v.variantId === "good",
          );
          if (!good) throw new Error("Missing designed pair.");
          const eligible =
            good.criteria[key].reference === "pass" &&
            bad.criteria[key].reference === "fail";
          return {
            familyId: bad.familyId,
            goodCaseId: good.caseId,
            defectiveCaseId: bad.caseId,
            eligible,
            goodReference: good.criteria[key].reference,
            defectiveReference: bad.criteria[key].reference,
            medianGap:
              median(good.criteria[key].scores) -
              median(bad.criteria[key].scores),
            gaps: good.criteria[key].scores.map(
              (score, i) => score - bad.criteria[key].scores[i],
            ),
          };
        });
      const eligiblePairs = pairs.filter((v) => v.eligible);
      return [
        key,
        {
          threshold: thresholds[key],
          ...outcome(
            cases.map((v) => ({
              reference: v.criteria[key].reference,
              passes: v.criteria[key].scores.map(
                (score) => score >= thresholds[key],
              ),
            })),
          ),
          medianAuc: auc(
            positives.map((v) => median(v.criteria[key].scores)),
            negatives.map((v) => median(v.criteria[key].scores)),
          ),
          pairSeparation: {
            eligible: eligiblePairs.length,
            excluded: pairs.length - eligiblePairs.length,
            positiveMedianGap: eligiblePairs.filter((v) => v.medianGap > 0)
              .length,
            tiedMedianGap: eligiblePairs.filter((v) => v.medianGap === 0)
              .length,
            reversedMedianGap: eligiblePairs.filter((v) => v.medianGap < 0)
              .length,
            positiveEveryRepeat: eligiblePairs.filter((v) =>
              v.gaps.every((gap) => gap > 0),
            ).length,
            pairs,
          },
        },
      ];
    }),
  );
  return {
    uniqueCases: cases.length,
    families: [...new Set(cases.map((v) => v.familyId))],
    thresholds,
    criteria,
    overall: outcome(
      cases.map((v) => ({
        reference: v.reference,
        passes: [0, 1, 2].map((repeat) =>
          keys.every(
            (key) => v.criteria[key].scores[repeat] >= thresholds[key],
          ),
        ),
      })),
    ),
    byCase: cases.map((v) => ({
      ...v,
      calibratedDecisions: [0, 1, 2].map((repeat) =>
        keys.every((key) => v.criteria[key].scores[repeat] >= thresholds[key]),
      ),
    })),
  };
}

export function selectControlledThresholds(calibrationCases: ControlledCase[]) {
  validateCases(calibrationCases);
  const perCriterion = Object.fromEntries(
    keys.map((key) => {
      const positive = calibrationCases.filter(
        (v) => v.criteria[key].reference === "pass",
      );
      const negative = calibrationCases.filter(
        (v) => v.criteria[key].reference === "fail",
      );
      const grid = Array.from({ length: 101 }, (_, index) => index / 100);
      const selected = negative.length
        ? grid.find((t) =>
            negative.every((v) =>
              v.criteria[key].scores.every((score) => score < t),
            ),
          )
        : undefined;
      const threshold = selected ?? 1;
      const acceptedPositivesEveryRepeat = positive.filter((v) =>
        v.criteria[key].scores.every((score) => score >= threshold),
      ).length;
      const acceptedNegativesAnyRepeat = negative.filter((v) =>
        v.criteria[key].scores.some((score) => score >= threshold),
      ).length;
      const feasible =
        selected !== undefined &&
        positive.length >= 6 &&
        negative.length >= 6 &&
        acceptedNegativesAnyRepeat === 0 &&
        acceptedPositivesEveryRepeat >= Math.ceil(positive.length / 2);
      return [
        key,
        {
          threshold,
          exists: selected !== undefined,
          referencePositive: positive.length,
          referenceNegative: negative.length,
          acceptedPositivesEveryRepeat,
          acceptedNegativesAnyRepeat,
          feasible,
        },
      ];
    }),
  ) as Record<
    ConsolidationCriterion,
    {
      threshold: number;
      exists: boolean;
      referencePositive: number;
      referenceNegative: number;
      acceptedPositivesEveryRepeat: number;
      acceptedNegativesAnyRepeat: number;
      feasible: boolean;
    }
  >;
  const thresholds = Object.fromEntries(
    keys.map((key) => [key, perCriterion[key].threshold]),
  ) as Thresholds;
  const assessment = assessControlled(calibrationCases, thresholds);
  const feasible =
    keys.every((key) => perCriterion[key].feasible) &&
    assessment.overall.reference.pass > 0 &&
    assessment.overall.descriptiveAll3.truePositive >=
      Math.ceil(assessment.overall.reference.pass / 2) &&
    assessment.overall.descriptiveAny.falsePositive === 0;
  return {
    thresholds,
    perCriterion,
    feasible,
    rule: CONTROLLED_SELECTION_RULE,
    assessment,
  };
}

async function saveOnce(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
}

async function main() {
  const { values } = parseArgs({
    options: { input: { type: "string" }, phase: { type: "string" } },
  });
  if (
    !values.input ||
    !["calibration", "validation"].includes(values.phase ?? "")
  )
    throw new Error("Use --input <directory> --phase calibration|validation");
  const directory = resolve(values.input);
  // Reconstruct the summary from validated frozen inputs and receipts; never
  // fit thresholds using a caller-supplied summary or an incomplete phase.
  const verified = await runControlled(
    { input: directory, phase: values.phase as "calibration" | "validation" },
    {
      verifyOnly: true,
      evaluate: async () => {
        throw new Error("Analysis cannot make provider calls.");
      },
    },
  );
  const protocolRaw = await readFile(join(directory, "protocol.json"), "utf8");
  const protocolHash = digest(JSON.stringify(JSON.parse(protocolRaw)));
  const summaryRaw = await readFile(
    join(directory, `summary-${values.phase}.json`),
    "utf8",
  );
  const cases = verified.byCase as ControlledCase[];
  const selectionPath = join(directory, "calibration.json");
  if (values.phase === "calibration") {
    const selection = selectControlledThresholds(cases);
    await saveOnce(selectionPath, {
      protocolHash,
      selectedAt: new Date().toISOString(),
      calibrationSummaryHash: digest(summaryRaw),
      analysisCodeHash: digest(
        await readFile(fileURLToPath(import.meta.url), "utf8"),
      ),
      ...selection,
    });
    console.log(
      JSON.stringify({
        phase: "calibration",
        cases: cases.length,
        feasible: selection.feasible,
        thresholds: selection.thresholds,
      }),
    );
  } else {
    const selectionRaw = await readFile(selectionPath, "utf8");
    const selection = JSON.parse(selectionRaw);
    const validationProtocol = JSON.parse(
      await readFile(join(directory, "validation-protocol.json"), "utf8"),
    );
    if (
      selection.protocolHash !== protocolHash ||
      validationProtocol.calibrationHash !== digest(selectionRaw)
    )
      throw new Error("Calibration is not frozen in the validation protocol.");
    const result = {
      analyzedAt: new Date().toISOString(),
      protocolHash,
      calibrationHash: digest(selectionRaw),
      validationSummaryHash: digest(summaryRaw),
      calibrationFeasible: selection.feasible,
      originalThresholds: assessControlled(cases, JEV_CONSOLIDATION_THRESHOLDS),
      selectedThresholds: assessControlled(cases, selection.thresholds),
      promotion: false,
      limitations: [
        "Synthetic documents and one shared-model blind reference; not production ground truth.",
        "Only four heldout families and three technical repetitions per case.",
        "Thresholds selected once on calibration; no validation refitting or automatic deployment.",
      ],
    };
    await saveOnce(join(directory, "validation-analysis.json"), result);
    console.log(
      JSON.stringify({
        phase: "validation",
        cases: cases.length,
        overall: result.selectedThresholds.overall,
      }),
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Controlled analysis failed.",
    );
    process.exitCode = 1;
  });
