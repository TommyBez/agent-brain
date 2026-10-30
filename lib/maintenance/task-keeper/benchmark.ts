import { z } from "zod";
import { type BrainPage, PAGE_TYPES } from "../../brain/types";
import { fingerprint } from "../../canonical-json";
import { normalizeForFingerprint } from "./dedupe";
import type { DueKind } from "./verify";

// Italian synthetic extraction benchmark (§8.5, release criterion 11): the
// dataset schema, the synthetic pages and the scoring. No I/O; the runner is
// scripts/task-extraction-benchmark.ts.

const DUE_KINDS = ["unset", "date", "approximate", "event"] as const;

const expectedItemSchema = z
  .object({
    /** An exact fragment of the passage the task must cite. */
    passage: z.string().min(3),
    /** The expected assignee as written, or null when the source names none. */
    actor: z.string().min(1).nullable(),
    dueKind: z.union([z.enum(DUE_KINDS), z.array(z.enum(DUE_KINDS)).min(1)]),
    dueDate: z.iso.date().optional(),
  })
  .strict();

const caseSchema = z
  .object({
    id: z.string().regex(/^C\d{2,3}$/),
    category: z.string().min(1),
    page: z
      .object({
        title: z.string().min(1).max(200),
        type: z.enum(PAGE_TYPES),
        markdown: z.string().min(1),
      })
      .strict(),
    expected: z.array(expectedItemSchema),
  })
  .strict()
  .superRefine((value, context) => {
    for (const item of value.expected)
      if (!value.page.markdown.includes(item.passage))
        context.addIssue({
          code: "custom",
          message: `${value.id}: passage not found in the page`,
        });
  });

export const extractionBenchmarkSchema = z
  .object({
    id: z.string().min(1),
    language: z.literal("it"),
    synthetic: z.literal(true),
    labels: z.string(),
    categories: z.record(z.string(), z.string()),
    cases: z.array(caseSchema).min(30),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set(value.cases.map((item) => item.id));
    if (ids.size !== value.cases.length)
      context.addIssue({ code: "custom", message: "Duplicate case ids" });
    for (const item of value.cases)
      if (!Object.hasOwn(value.categories, item.category))
        context.addIssue({
          code: "custom",
          message: `${item.id}: unknown category ${item.category}`,
        });
  });
export type ExtractionBenchmark = z.output<typeof extractionBenchmarkSchema>;
export type ExtractionCase = ExtractionBenchmark["cases"][number];

/** A synthetic, versioned page with a stable id derived from the case. */
export function benchmarkPage(item: ExtractionCase): BrainPage {
  const hex = fingerprint({ benchmark: "task-extraction", case: item.id });
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return {
    id,
    slug: `note/benchmark-${item.id.toLowerCase()}`,
    title: item.page.title,
    type: item.page.type,
    summary: "",
    relationships: [],
    aliases: [],
    tags: [],
    version: 1,
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    embeddedAt: null,
    markdown: item.page.markdown,
    links: [],
    backlinks: [],
  };
}

export interface PredictedItem {
  title: string;
  /** The cited passages' text, from the snapshot. */
  excerpt: string;
  actorNames: string[];
  dueKind: DueKind;
  dueDate: string | null;
  dueText: string | null;
}

export interface CaseScore {
  id: string;
  category: string;
  expected: number;
  predicted: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** Every expected item found and nothing else. */
  correct: boolean;
  actorCorrect: number;
  dueKindCorrect: number;
  dueDateCorrect: number;
  dueDateExpected: number;
  /** Predicted actors that never appear in the page text. */
  inventedActors: number;
  /** Predicted dates on items where the labels expect none or another. */
  wrongDates: number;
  matches: { expected: number; predicted: number }[];
}

const words = (value: string) => normalizeForFingerprint(value);

function actorMatches(expected: string | null, predicted: string[]) {
  if (expected === null) return predicted.length === 0;
  const target = words(expected);
  return predicted.some((name) => {
    const value = words(name);
    return value === target || value.includes(target) || target.includes(value);
  });
}

/** Greedy one-to-one matching on the cited passage. Pure. */
export function scoreCase(
  item: ExtractionCase,
  predicted: PredictedItem[],
): CaseScore {
  const used = new Set<number>();
  const matches: CaseScore["matches"] = [];
  let actorCorrect = 0;
  let dueKindCorrect = 0;
  let dueDateCorrect = 0;
  let wrongDates = 0;
  item.expected.forEach((expected, index) => {
    const found = predicted.findIndex(
      (candidate, position) =>
        !used.has(position) &&
        words(candidate.excerpt).includes(words(expected.passage)),
    );
    if (found < 0) return;
    used.add(found);
    matches.push({ expected: index, predicted: found });
    const prediction = predicted[found];
    if (actorMatches(expected.actor, prediction.actorNames)) actorCorrect++;
    const kinds = Array.isArray(expected.dueKind)
      ? expected.dueKind
      : [expected.dueKind];
    if (kinds.includes(prediction.dueKind)) dueKindCorrect++;
    if (expected.dueDate && prediction.dueDate === expected.dueDate)
      dueDateCorrect++;
    if (prediction.dueDate && prediction.dueDate !== expected.dueDate)
      wrongDates++;
  });
  // Any date on an item that matches no expected commitment is invented.
  wrongDates += predicted.filter(
    (prediction, position) => !used.has(position) && prediction.dueDate,
  ).length;
  const page = words(item.page.markdown);
  const inventedActors = predicted
    .flatMap((prediction) => prediction.actorNames)
    .filter((name) => !page.includes(words(name))).length;
  const truePositives = matches.length;
  return {
    id: item.id,
    category: item.category,
    expected: item.expected.length,
    predicted: predicted.length,
    truePositives,
    falsePositives: predicted.length - truePositives,
    falseNegatives: item.expected.length - truePositives,
    correct:
      truePositives === item.expected.length &&
      predicted.length === truePositives,
    actorCorrect,
    dueKindCorrect,
    dueDateCorrect,
    dueDateExpected: item.expected.filter((expected) => expected.dueDate)
      .length,
    inventedActors,
    wrongDates: wrongDates,
    matches,
  };
}

const ratio = (numerator: number, denominator: number) =>
  denominator ? numerator / denominator : null;

export function benchmarkMetrics(scores: CaseScore[]) {
  const sum = (field: keyof CaseScore) =>
    scores.reduce((total, score) => total + Number(score[field]), 0);
  const truePositives = sum("truePositives");
  const falsePositives = sum("falsePositives");
  const falseNegatives = sum("falseNegatives");
  const precision = ratio(truePositives, truePositives + falsePositives);
  const recall = ratio(truePositives, truePositives + falseNegatives);
  const categories: Record<string, { cases: number; accuracy: number | null }> =
    {};
  for (const score of scores) {
    const entry = categories[score.category] ?? { cases: 0, accuracy: 0 };
    entry.cases++;
    entry.accuracy = (entry.accuracy ?? 0) + (score.correct ? 1 : 0);
    categories[score.category] = entry;
  }
  for (const entry of Object.values(categories))
    entry.accuracy = ratio(entry.accuracy ?? 0, entry.cases);
  const negatives = scores.filter((score) => score.expected === 0);
  return {
    items: {
      truePositives,
      falsePositives,
      falseNegatives,
      precision,
      recall,
      f1:
        precision !== null && recall !== null && precision + recall > 0
          ? (2 * precision * recall) / (precision + recall)
          : null,
    },
    caseAccuracy: ratio(
      scores.filter((score) => score.correct).length,
      scores.length,
    ),
    /** Tasks created from proposals, hypotheses, done items, agent advice… */
    inventedTasks: negatives.reduce(
      (total, score) => total + score.predicted,
      0,
    ),
    inventedActors: sum("inventedActors"),
    wrongDates: sum("wrongDates"),
    fields: {
      actor: ratio(sum("actorCorrect"), truePositives),
      dueKind: ratio(sum("dueKindCorrect"), truePositives),
      dueDate: ratio(sum("dueDateCorrect"), sum("dueDateExpected")),
    },
    categories,
  };
}
