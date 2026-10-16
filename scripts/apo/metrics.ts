import type { PromptTask } from "../../lib/maintenance/consolidator/prompts";
import { TASKS } from "./tasks";
import type { Config, Prediction } from "./types";

const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const percentile = (values: number[], q: number) =>
  [...values].sort((a, b) => a - b)[
    Math.max(0, Math.ceil(values.length * q) - 1)
  ] ?? 0;

export function classification(rows: Prediction[], labels: string[]) {
  const confusion = Object.fromEntries(
    labels.map((actual) => [
      actual,
      Object.fromEntries(
        [...labels, "abstain", "error"].map((predicted) => [
          predicted,
          rows.filter((r) => r.expected === actual && r.predicted === predicted)
            .length,
        ]),
      ),
    ]),
  );
  const perClass = Object.fromEntries(
    labels.map((label) => {
      const tp = rows.filter(
        (r) => r.expected === label && r.predicted === label,
      ).length;
      const fp = rows.filter(
        (r) => r.expected !== label && r.predicted === label,
      ).length;
      const fn = rows.filter(
        (r) => r.expected === label && r.predicted !== label,
      ).length;
      return [
        label,
        {
          support: tp + fn,
          precision: tp + fp ? tp / (tp + fp) : 0,
          recall: tp + fn ? tp / (tp + fn) : 0,
          f1: 2 * tp + fp + fn ? (2 * tp) / (2 * tp + fp + fn) : 0,
        },
      ];
    }),
  );
  return {
    count: rows.length,
    accuracy: mean(rows.map((r) => Number(r.expected === r.predicted))),
    macroF1: mean(Object.values(perClass).map((v) => v.f1)),
    confusion,
    perClass,
  };
}

/** Average precision with ties grouped, using raw boolean probabilities, never labels. */
export function averagePrecision(rows: Prediction[]): number | null {
  if (rows.some((r) => r.error || r.probability === null)) return null;
  const positives = rows.filter((r) => r.expected === "true").length;
  if (!positives) return null;
  let tp = 0;
  let count = 0;
  let ap = 0;
  for (const p of [...new Set(rows.map((r) => r.probability as number))].sort(
    (a, b) => b - a,
  )) {
    const ties = rows.filter((r) => r.probability === p);
    const positive = ties.filter((r) => r.expected === "true").length;
    tp += positive;
    count += ties.length;
    ap += ((positive / positives) * tp) / count;
  }
  return ap;
}

export function metrics(task: PromptTask, rows: Prediction[]) {
  const labels = TASKS[task].labels;
  const groups = (key: "language" | "category") =>
    Object.fromEntries(
      [...new Set(rows.map((r) => r[key]))].sort().map((value) => [
        value,
        classification(
          rows.filter((r) => r[key] === value),
          labels.filter((label) =>
            rows.some((r) => r[key] === value && r.expected === label),
          ),
        ),
      ]),
    );
  const byExample = [...new Set(rows.map((r) => r.exampleId))].map((id) =>
    rows.filter((r) => r.exampleId === id),
  );
  const failures = rows.filter((r) => r.error).length;
  const negatives = rows.filter((r) => r.expected === "false");
  return {
    ...classification(rows, labels),
    examples: byExample.length,
    sourceGroups: new Set(rows.map((r) => r.group)).size,
    byLanguage: groups("language"),
    byCategory: groups("category"),
    formatSuccess: rows.length ? 1 - failures / rows.length : 0,
    failures,
    abstentions: rows.filter((r) => r.predicted === "abstain").length,
    falsePositiveRate: negatives.length
      ? negatives.filter((r) => r.predicted === "true").length /
        negatives.length
      : null,
    averagePrecision: labels.includes("true") ? averagePrecision(rows) : null,
    repeatDisagreement: mean(
      byExample.map((group) =>
        Number(new Set(group.map((r) => r.predicted)).size > 1),
      ),
    ),
    latencyMs: {
      mean: mean(rows.map((r) => r.latencyMs)),
      p50: percentile(
        rows.map((r) => r.latencyMs),
        0.5,
      ),
      p95: percentile(
        rows.map((r) => r.latencyMs),
        0.95,
      ),
    },
    meanInputTokens: rows.some((r) => r.inputTokens === null)
      ? null
      : mean(rows.map((r) => r.inputTokens ?? 0)),
    meanOutputTokens: rows.some((r) => r.outputTokens === null)
      ? null
      : mean(rows.map((r) => r.outputTokens ?? 0)),
    meanCostDollars: rows.some((r) => r.costDollars === null)
      ? null
      : mean(rows.map((r) => r.costDollars ?? 0)),
  };
}
export type Metrics = ReturnType<typeof metrics>;

/** Paired cluster bootstrap: repeats/variants from a source are NOT independent samples. */
export function pairedInterval(
  task: PromptTask,
  baseline: Prediction[],
  candidate: Prediction[],
  seed: number,
) {
  const groups = [...new Set(baseline.map((r) => r.group))].sort();
  if (!groups.length || baseline.length !== candidate.length)
    throw new Error("Unpaired comparison");
  const keys = (rows: Prediction[]) =>
    rows
      .map((r) => `${r.exampleId}:${r.repeat}`)
      .sort()
      .join("|");
  if (keys(baseline) !== keys(candidate))
    throw new Error("Unpaired comparison");
  let state = seed >>> 0;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const deltas: number[] = [];
  for (let trial = 0; trial < 1000; trial++) {
    const sample = groups.map(
      () => groups[Math.floor(random() * groups.length)],
    );
    const score = (rows: Prediction[]) =>
      classification(
        sample.flatMap((group) => rows.filter((r) => r.group === group)),
        TASKS[task].labels,
      ).macroF1;
    deltas.push(score(candidate) - score(baseline));
  }
  return {
    lower: percentile(deltas, 0.025),
    upper: percentile(deltas, 0.975),
    method: "paired-source-cluster-bootstrap-1000" as const,
    groups: groups.length,
  };
}

export function selectCandidate(
  task: PromptTask,
  previous: Prediction[],
  candidate: Prediction[],
  config: Config,
) {
  const before = metrics(task, previous);
  const after = metrics(task, candidate);
  const reasons: string[] = [];
  const interval = pairedInterval(task, previous, candidate, config.seed);
  if (after.macroF1 - before.macroF1 < config.minImprovement)
    reasons.push("insufficient_primary_improvement");
  if (after.formatSuccess < 1) reasons.push("technical_or_format_failure");
  if (
    after.repeatDisagreement > 0 &&
    after.macroF1 - before.macroF1 <= after.repeatDisagreement
  )
    reasons.push("improvement_below_repeat_variability");
  if (interval.lower < -1e-12) reasons.push("uncertain_regression");
  if (
    (after.falsePositiveRate ?? 0) >
    (before.falsePositiveRate ?? 0) + config.maxFalsePositiveIncrease + 1e-12
  )
    reasons.push("false_positive_regression");
  for (const dimension of ["byLanguage", "byCategory"] as const)
    for (const [key, value] of Object.entries(before[dimension])) {
      if (
        value.accuracy - (after[dimension][key]?.accuracy ?? 0) >
        config.maxSubgroupDrop + 1e-12
      )
        reasons.push(`${dimension}_regression:${key}`);
    }
  for (const [label, value] of Object.entries(before.perClass))
    if (
      value.recall - (after.perClass[label]?.recall ?? 0) >
      config.maxSubgroupDrop + 1e-12
    )
      reasons.push(`class_recall_regression:${label}`);
  if (after.latencyMs.p95 > config.maxLatencyMs) reasons.push("latency_limit");
  return { accepted: reasons.length === 0, reasons, before, after, interval };
}
