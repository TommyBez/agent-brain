import { z } from "zod";
import type { EvaluationRequest } from "../consolidator/types";
import {
  buildLinkRequest,
  type LinkedRole,
  linkRole,
  type PageJudgment,
} from "./questions";

// The task_relevance benchmark (§8.3 release criterion): synthetic Italian
// scenarios, one production Jev request per task, metrics per role.

export const BENCHMARK_CATEGORIES = [
  "decisione_pertinente",
  "stakeholder",
  "contesto_pertinente",
  "stesso_tema_non_pertinente",
  "decisione_superata",
  "menzione_incidentale",
] as const;
export const REQUIRED_CATEGORIES = [
  "decisione_pertinente",
  "stesso_tema_non_pertinente",
  "stakeholder",
  "decisione_superata",
  "menzione_incidentale",
] as const;
export const EXPECTED_ROLES = [
  "decision",
  "stakeholder",
  "context",
  "none",
] as const;
export type ExpectedRole = (typeof EXPECTED_ROLES)[number];

const text = (max: number) => z.string().trim().min(1).max(max);
const caseSchema = z
  .object({
    id: z.string().regex(/^S\d{2}-P\d{1,2}$/),
    category: z.enum(BENCHMARK_CATEGORIES),
    expected: z.enum(EXPECTED_ROLES),
    page: z
      .object({
        title: text(200),
        type: z.enum([
          "person",
          "company",
          "project",
          "article",
          "decision",
          "note",
        ]),
        summary: text(500),
        excerpt: text(1200),
      })
      .strict(),
  })
  .strict();
export const benchmarkSchema = z
  .object({
    id: z.string(),
    language: z.literal("it"),
    synthetic: z.literal(true),
    labels: z.string(),
    categories: z.record(z.enum(BENCHMARK_CATEGORIES), z.string()),
    scenarios: z
      .array(
        z
          .object({
            id: z.string().regex(/^S\d{2}$/),
            task: z
              .object({
                title: text(200),
                description: text(3000),
                acceptanceCriteria: z.array(text(500)).max(20),
              })
              .strict(),
            pages: z.array(caseSchema).min(1).max(12),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((data, context) => {
    const ids = data.scenarios.flatMap((scenario) =>
      scenario.pages.map((page) => page.id),
    );
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: "custom", message: "Duplicate case ids" });
    if (ids.length < 30)
      context.addIssue({ code: "custom", message: "At least 30 cases" });
    for (const category of REQUIRED_CATEGORIES)
      if (
        !data.scenarios.some((scenario) =>
          scenario.pages.some((page) => page.category === category),
        )
      )
        context.addIssue({
          code: "custom",
          message: `Missing category ${category}`,
        });
  });
export type Benchmark = z.infer<typeof benchmarkSchema>;
export type BenchmarkScenario = Benchmark["scenarios"][number];

export function benchmarkRequest(
  scenario: BenchmarkScenario,
): EvaluationRequest {
  return buildLinkRequest(
    scenario.task,
    scenario.pages.map((item) => item.page),
  );
}

export interface CasePrediction {
  id: string;
  category: string;
  expected: ExpectedRole;
  predicted: ExpectedRole;
  judgment: PageJudgment;
}

export function predictedRole(judgment: PageJudgment): ExpectedRole {
  return linkRole(judgment)?.role ?? "none";
}

const ratio = (numerator: number, denominator: number) =>
  denominator ? numerator / denominator : null;

export interface RoleMetrics {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

function roleMetrics(
  predictions: CasePrediction[],
  matches: (role: ExpectedRole) => boolean,
): RoleMetrics {
  const truePositives = predictions.filter(
    (item) => matches(item.predicted) && matches(item.expected),
  ).length;
  const falsePositives = predictions.filter(
    (item) => matches(item.predicted) && !matches(item.expected),
  ).length;
  const falseNegatives = predictions.filter(
    (item) => matches(item.expected) && !matches(item.predicted),
  ).length;
  const precision = ratio(truePositives, truePositives + falsePositives);
  const recall = ratio(truePositives, truePositives + falseNegatives);
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1:
      precision !== null && recall !== null && precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : null,
  };
}

/** Per role (exact role match) and for link detection (any role vs none). */
export function benchmarkMetrics(predictions: CasePrediction[]) {
  const roles = Object.fromEntries(
    (["decision", "stakeholder", "context"] as LinkedRole[]).map((role) => [
      role,
      roleMetrics(predictions, (value) => value === role),
    ]),
  ) as Record<LinkedRole, RoleMetrics>;
  const categories = Object.fromEntries(
    BENCHMARK_CATEGORIES.map((category) => {
      const items = predictions.filter((item) => item.category === category);
      return [
        category,
        {
          cases: items.length,
          accuracy: ratio(
            items.filter((item) => item.predicted === item.expected).length,
            items.length,
          ),
        },
      ];
    }),
  );
  const confusion = Object.fromEntries(
    EXPECTED_ROLES.map((expected) => [
      expected,
      Object.fromEntries(
        EXPECTED_ROLES.map((predicted) => [
          predicted,
          predictions.filter(
            (item) =>
              item.expected === expected && item.predicted === predicted,
          ).length,
        ]),
      ),
    ]),
  );
  return {
    cases: predictions.length,
    accuracy: ratio(
      predictions.filter((item) => item.predicted === item.expected).length,
      predictions.length,
    ),
    linkDetection: roleMetrics(predictions, (value) => value !== "none"),
    roles,
    categories,
    confusion,
  };
}
