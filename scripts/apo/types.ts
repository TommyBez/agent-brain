import { z } from "zod";
import {
  PROMPT_TASKS,
  type PromptTask,
} from "../../lib/maintenance/consolidator/prompts";
import type {
  Answer,
  EvaluationRequest,
} from "../../lib/maintenance/consolidator/types";

export const labelSchema = z
  .object({
    value: z.string().min(1),
    method: z.enum([
      "deterministic",
      "outcome",
      "human",
      "llm",
      "consensus",
      "hybrid",
    ]),
    source: z.string().min(1),
    version: z.string().min(1),
    status: z.enum(["constructed", "validated", "estimated", "uncertain"]),
    confidence: z.number().min(0).max(1).nullable(),
    agreement: z.number().min(0).max(1).nullable(),
    models: z.array(z.string()),
    rationale: z.string().min(1),
  })
  .strict();
export const exampleSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    group: z.string().min(1),
    task: z.enum(PROMPT_TASKS),
    language: z.literal("it"),
    category: z.string().min(1),
    origin: z.enum(["synthetic", "real"]),
    state: z.json(),
    pair: z.boolean(),
    direction: z.enum(["ab", "ba"]).default("ab"),
    direct: z.boolean().default(false),
    context: z
      .object({
        unitIndex: z.number().int().nonnegative().optional(),
        anchorId: z.string().optional(),
        optionIds: z.array(z.string()).min(1).max(254).optional(),
        verification: z
          .object({ questionId: z.string(), requirement: z.string().min(20) })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    label: labelSchema,
  })
  .strict();
export type Example = z.infer<typeof exampleSchema>;
export type Label = z.infer<typeof labelSchema>;
export type Split = "train" | "validation" | "test";
export type Splits = Record<Split, string[]>;

export const configSchema = z
  .object({
    tasks: z.array(z.enum(PROMPT_TASKS)).min(1),
    seed: z.number().int().nonnegative().default(20261016),
    iterations: z.number().int().min(1).max(5).default(5),
    repeats: z.number().int().min(1).max(10).default(2),
    concurrency: z.number().int().min(1).max(4).default(1),
    patience: z.number().int().min(1).max(5).default(2),
    maxErrors: z.number().int().min(1).max(30).default(12),
    minImprovement: z.number().positive().max(1).default(0.01),
    maxSubgroupDrop: z.number().min(0).max(1).default(0.05),
    maxFalsePositiveIncrease: z.number().min(0).max(1).default(0),
    maxPromptCharacters: z.number().int().min(1000).max(6000).default(4000),
    maxPromptTokens: z.number().int().min(400).max(2000).default(1200),
    maxLatencyMs: z.number().positive().default(10000),
    maxCalls: z.number().int().positive().default(6000),
    maxTokens: z.number().int().positive().default(4_000_000),
    maxDollars: z.number().positive().default(2),
    optimizerModel: z.string().min(1).default("deepseek/deepseek-v4.1-flash"),
    judgeModels: z.array(z.string().min(1)).default([]),
    optimizerMaxTokens: z.number().int().min(1000).max(16000).default(8192),
    optimizerTemperature: z.number().min(0).max(2).default(0),
    smoke: z.boolean().default(false),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export type Prediction = {
  id: string;
  exampleId: string;
  task: PromptTask;
  split: Split;
  promptHash: string;
  repeat: number;
  expected: string;
  predicted: string;
  probability: number | null;
  answer: Answer | null;
  model: string;
  language: Example["language"];
  category: string;
  group: string;
  origin: Example["origin"];
  supervision: Label;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costDollars: number | null;
  error: string | null;
};
export type ModelResult = {
  answer: Answer;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costDollars: number | null;
  latencyMs?: number;
};
export type DecisionModel = (
  request: EvaluationRequest,
  callId: string,
) => Promise<ModelResult>;

export const proposalSchema = z
  .object({
    candidate_prompt: z.string().min(20).max(6000),
    changes: z.array(z.string().min(1)).min(1),
    targeted_failure_modes: z.array(z.string().min(1)).min(1),
    rationale: z.string().min(1),
    potential_regressions: z.array(z.string()),
    hypothesis: z.string().min(1),
  })
  .strict();
export type Proposal = z.infer<typeof proposalSchema>;
export type OptimizerInput = {
  task: PromptTask;
  currentPrompt: string;
  errors: { example: Example; prediction: Prediction }[];
  previous: { changes: string[]; reason: string[] }[];
  maxCharacters: number;
  maxTokens: number;
};
export type Optimizer = (
  input: OptimizerInput,
  callId: string,
) => Promise<Proposal>;
