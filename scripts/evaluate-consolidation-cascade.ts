import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadEnvConfig } from "@next/env";
import { z } from "zod";
import {
  applyPositiveConsolidationPolicy,
  type PositiveConsolidationEvaluation,
} from "../lib/maintenance/consolidation-policy";
import {
  CONSOLIDATION_CRITERIA,
  CONSOLIDATION_QUESTIONS_V2,
  type ConsolidationCriterion,
} from "../lib/maintenance/consolidation-rubric";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import {
  evaluateConsolidationProposal,
  JEV_CONSOLIDATION_THRESHOLDS,
  JEV_MODEL,
} from "../lib/maintenance/jev";
import {
  evaluateWithKimi,
  KIMI_EVALUATOR_SETTINGS,
  KIMI_MODEL,
} from "../lib/maintenance/kimi-evaluator";

// Offline experiment orchestration only. No database or production gate writes.
export const cascadeCriteria = CONSOLIDATION_CRITERIA;
type Criterion = ConsolidationCriterion;
type KimiEvaluation = Awaited<ReturnType<typeof evaluateWithKimi>>;
export type CascadeStage = "jev" | "kimi";
export type CascadeVerdict = "pass" | "fail" | "uncertain" | "error";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const labelSchema = z.strictObject({
  verdict: z.enum(["pass", "fail", "uncertain"]),
  rationale: z.string().trim().min(1).max(10_000),
});
const fourLabels = z.strictObject({
  supported_by_evidence: labelSchema,
  preserves_distinct_information: labelSchema,
  no_new_human_action: labelSchema,
  meaningful_improvement: labelSchema,
});
const caseSchema = z.object({
  caseId: z.string().min(1),
  inputHash: digest,
  input: z.strictObject({
    before: z.unknown(),
    after: z.unknown(),
    evidence: z.unknown(),
    operation: z.unknown(),
  }),
});
const reviewSchema = z.strictObject({
  reviewer: z.literal("blind-subagent"),
  rubricHash: digest,
  candidates: z.array(
    z.strictObject({
      caseId: z.string().min(1),
      inputHash: digest,
      criteria: fourLabels,
    }),
  ),
});
const partitionSchema = z.object({
  cases: z.array(
    z.strictObject({
      caseId: z.string().min(1),
      familyId: z.string().min(1),
      variantId: z.string().min(1),
      targetCriterion: z.enum(CONSOLIDATION_CRITERIA).nullable(),
    }),
  ),
});
const bandSchema = z
  .object({
    rejectBelow: z.number().min(0).max(1),
    acceptAtOrAbove: z.number().min(0).max(1.01),
  })
  .refine((band) => band.rejectBelow <= band.acceptAtOrAbove, "Bands overlap.");
const bandsSchema = z.object({
  criteria: z.strictObject({
    supported_by_evidence: bandSchema,
    preserves_distinct_information: bandSchema,
    no_new_human_action: bandSchema,
    meaningful_improvement: bandSchema,
  }),
});
type Case = z.infer<typeof caseSchema>;
type Review = z.infer<typeof reviewSchema>;
type Partition = z.infer<typeof partitionSchema>["cases"];
type Bands = z.infer<typeof bandsSchema>["criteria"];
type Kind = "jev" | "kimi-baseline" | "kimi-selective";
type Job = { id: string; caseIndex: number; kind: Kind; criteria: Criterion[] };
type Identity = Job & {
  caseId: string;
  inputHash: string;
  protocolHash: string;
  phaseProtocolHash: string;
  reviewHash: string;
  rubricHash: string;
  payloadHash: string;
};
export type CascadeSafeError = {
  class: "http" | "invalid_response" | "nonretryable" | "transport_or_unknown";
  status: number | null;
  retryable: boolean;
};
type Attempt = {
  startedAt: string;
  endedAt?: string;
  latencyMs?: number;
  outcome: "started" | "success" | "error";
  error?: CascadeSafeError;
};
type Journal = { protocolHash: string; jobHash: string; attempts: Attempt[] };
export type CascadeReceipt = Identity & {
  evaluatedAt: string;
  attempts: number;
  latencyMs: number;
} & (
    | {
        outcome: "success";
        result: PositiveConsolidationEvaluation | KimiEvaluation;
      }
    | { outcome: "failed"; error: CascadeSafeError }
  );
export type CascadeDependencies = {
  evaluateJev?: typeof evaluateConsolidationProposal;
  evaluateKimi?: typeof evaluateWithKimi;
  verifyOnly?: boolean;
  sleep?: (milliseconds: number) => Promise<void>;
  progress?: (progress: {
    stage: CascadeStage;
    completed: number;
    total: number;
    failed: number;
  }) => void;
};
type Routing = {
  state: "red" | "green" | "gray" | "error";
  bands: Partial<Record<Criterion, "red" | "green" | "gray">>;
  grayCriteria: Criterion[];
};
export type CascadeArm = {
  verdict: CascadeVerdict;
  criteria: Record<Criterion, CascadeVerdict>;
  complete: boolean;
};

export function hashCascadeText(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
export function cascadeHash(value: unknown) {
  return hashCascadeText(JSON.stringify(value));
}
function invalid(message: string): never {
  throw new Error(message);
}
class InvalidEvaluation extends Error {}
const artifactNames = [
  "cases.json",
  "subagent-review.json",
  "evaluation-spec.json",
  "rubric.json",
  "partition.json",
  "bands.json",
];
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function optional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}
async function save(path: string, value: unknown, immutable = false) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (immutable) {
    await writeFile(path, text, { mode: 0o600, flag: "wx" });
    return;
  }
  await writeFile(`${path}.tmp`, text, { mode: 0o600 });
  await chmod(`${path}.tmp`, 0o600);
  await rename(`${path}.tmp`, path);
}
function validTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value &&
    Date.parse(value) <= Date.now()
  );
}
function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function criteriaRecord<T>(get: (key: Criterion) => T) {
  return Object.fromEntries(
    cascadeCriteria.map((key) => [key, get(key)]),
  ) as Record<Criterion, T>;
}
function overall(values: CascadeVerdict[]): CascadeVerdict {
  return values.includes("error")
    ? "error"
    : values.includes("fail")
      ? "fail"
      : values.includes("uncertain")
        ? "uncertain"
        : "pass";
}
function arm(
  criteria: Record<Criterion, CascadeVerdict>,
  complete = true,
): CascadeArm {
  return { verdict: overall(Object.values(criteria)), criteria, complete };
}
function validateJev(result: PositiveConsolidationEvaluation) {
  if (
    !result ||
    result.model !== JEV_MODEL ||
    !result.answers ||
    Object.keys(result.answers).length !== 4 ||
    cascadeCriteria.some(
      (key) => !number(result.answers[key]) || result.answers[key] > 1,
    ) ||
    result.allowed !==
      cascadeCriteria.every(
        (key) => result.answers[key] >= JEV_CONSOLIDATION_THRESHOLDS[key],
      ) ||
    !result.usage ||
    !Array.isArray(result.reasons) ||
    result.reasons.some((reason) => typeof reason !== "string") ||
    Object.entries(result.usage).some(
      ([key, value]) => key !== "gateway" && !number(value),
    ) ||
    Object.values(result.usage.gateway ?? {}).some((value) => !number(value))
  )
    throw new InvalidEvaluation("Invalid Jev evaluation.");
}
function validateKimi(result: KimiEvaluation, criteria: Criterion[]) {
  if (
    !result ||
    result.model !== KIMI_MODEL ||
    !number(result.latencyMs) ||
    !(
      result.responseModel === null || typeof result.responseModel === "string"
    ) ||
    !(result.responseId === null || typeof result.responseId === "string") ||
    !result.judgments ||
    Object.keys(result.judgments).length !== criteria.length ||
    criteria.some(
      (key) => !labelSchema.safeParse(result.judgments[key]).success,
    ) ||
    !result.usage ||
    [
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "reasoningTokens",
      "cachedInputTokens",
      "costUsd",
    ].some((key) => {
      const value = result.usage[key as keyof KimiEvaluation["usage"]];
      return value !== null && !number(value);
    })
  )
    throw new InvalidEvaluation("Invalid Kimi evaluation.");
}
function safeError(error: unknown): CascadeSafeError {
  if (error instanceof InvalidEvaluation)
    return { class: "invalid_response", status: null, retryable: false };
  if (error instanceof GatewayRequestError) {
    const status = error.status;
    return {
      class:
        status !== null
          ? "http"
          : error.retryable
            ? "transport_or_unknown"
            : "nonretryable",
      status,
      retryable:
        error.retryable &&
        status !== null &&
        (status === 429 || (status >= 500 && status <= 599)),
    };
  }
  return { class: "transport_or_unknown", status: null, retryable: false };
}
function validateError(error: CascadeSafeError | undefined) {
  if (
    !error ||
    ![
      "http",
      "invalid_response",
      "nonretryable",
      "transport_or_unknown",
    ].includes(error.class) ||
    !(
      error.status === null ||
      (Number.isInteger(error.status) &&
        error.status >= 100 &&
        error.status <= 599)
    ) ||
    typeof error.retryable !== "boolean" ||
    (error.class === "http") !== (error.status !== null) ||
    (error.retryable &&
      !(error.status === 429 || (error.status !== null && error.status >= 500)))
  )
    invalid("Invalid sanitized error metadata.");
}
function jevResult(receipt: CascadeReceipt | undefined) {
  return receipt?.outcome === "success" && receipt.kind === "jev"
    ? (receipt.result as PositiveConsolidationEvaluation)
    : undefined;
}
function kimiResult(receipt: CascadeReceipt | undefined) {
  return receipt?.outcome === "success" && receipt.kind !== "jev"
    ? (receipt.result as KimiEvaluation)
    : undefined;
}
function route(receipt: CascadeReceipt | undefined, bands: Bands): Routing {
  const result = jevResult(receipt);
  if (!result) return { state: "error", bands: {}, grayCriteria: [] };
  const colors = criteriaRecord((key) =>
    result.answers[key] < bands[key].rejectBelow
      ? ("red" as const)
      : result.answers[key] >= bands[key].acceptAtOrAbove
        ? ("green" as const)
        : ("gray" as const),
  );
  const grayCriteria = cascadeCriteria.filter((key) => colors[key] === "gray");
  return {
    state: Object.values(colors).includes("red")
      ? "red"
      : grayCriteria.length
        ? "gray"
        : "green",
    bands: colors,
    grayCriteria,
  };
}
function job(
  caseIndex: number,
  kind: Kind,
  criteria: readonly Criterion[] = cascadeCriteria,
): Job {
  return {
    id: `${String(caseIndex + 1).padStart(4, "0")}-${kind}`,
    caseIndex,
    kind,
    criteria: [...criteria],
  };
}
function kimiJobs(
  cases: Case[],
  receipts: Map<string, CascadeReceipt>,
  bands: Bands,
) {
  return cases.map((_, index) => {
    const routing = route(receipts.get(job(index, "jev").id), bands);
    const baseline = job(index, "kimi-baseline");
    if (routing.state !== "gray") return [baseline];
    const selective = job(index, "kimi-selective", routing.grayCriteria);
    return index % 2 === 0 ? [baseline, selective] : [selective, baseline];
  });
}
function metrics(inputReceipts: CascadeReceipt[]) {
  // Concurrent completion order must not change floating-point cost totals on resume.
  const receipts = [...inputReceipts].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const keys = [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "reasoningTokens",
    "cachedInputTokens",
    "costUsd",
  ] as const;
  const usage = Object.fromEntries(
    keys.map((key) => [key, { known: 0, missingJobs: 0 }]),
  ) as Record<(typeof keys)[number], { known: number; missingJobs: number }>;
  for (const receipt of receipts) {
    const result = receipt.outcome === "success" ? receipt.result : undefined;
    for (const key of keys) {
      const value = !result
        ? null
        : receipt.kind === "jev"
          ? key === "costUsd"
            ? ((result as PositiveConsolidationEvaluation).usage.gateway
                ?.cost ??
              (result as PositiveConsolidationEvaluation).usage.gateway
                ?.totalCost ??
              null)
            : ((result as PositiveConsolidationEvaluation).usage[
                key as "inputTokens" | "outputTokens" | "totalTokens"
              ] ?? null)
          : (result as KimiEvaluation).usage[key];
      if (number(value)) usage[key].known += value;
      else usage[key].missingJobs++;
    }
  }
  return {
    jobs: receipts.length,
    requests: receipts.reduce((sum, receipt) => sum + receipt.attempts, 0),
    successfulJobs: receipts.filter((receipt) => receipt.outcome === "success")
      .length,
    failedJobs: receipts.filter((receipt) => receipt.outcome === "failed")
      .length,
    latencyMs: receipts.reduce((sum, receipt) => sum + receipt.latencyMs, 0),
    usage,
    unreportedAttemptUsage: receipts.reduce(
      (sum, receipt) =>
        sum + receipt.attempts - Number(receipt.outcome === "success"),
      0,
    ),
  };
}
function summarize(
  stage: CascadeStage,
  cases: Case[],
  review: Review,
  partition: Partition,
  bands: Bands,
  receipts: Map<string, CascadeReceipt>,
) {
  const reviews = new Map(review.candidates.map((item) => [item.caseId, item]));
  const partitions = new Map(partition.map((item) => [item.caseId, item]));
  const byCase = cases.map((item, index) => {
    const reviewed =
      reviews.get(item.caseId) ?? invalid("Missing blind reference.");
    const partitioned =
      partitions.get(item.caseId) ?? invalid("Missing partition membership.");
    const jev = receipts.get(job(index, "jev").id);
    if (!jev) invalid("Summary requires resolved Jev receipts.");
    const result = jevResult(jev);
    const routing = route(jev, bands);
    const baseline =
      stage === "kimi"
        ? receipts.get(job(index, "kimi-baseline").id)
        : undefined;
    const selective =
      stage === "kimi"
        ? receipts.get(job(index, "kimi-selective").id)
        : undefined;
    const baselineResult = kimiResult(baseline);
    const selectiveResult = kimiResult(selective);
    const cascade = arm(
      criteriaRecord((key) =>
        routing.state === "error"
          ? "error"
          : routing.bands[key] === "red"
            ? "fail"
            : routing.bands[key] === "green"
              ? "pass"
              : routing.state === "red"
                ? "uncertain"
                : (selectiveResult?.judgments[key]?.verdict ?? "error"),
      ),
      routing.state !== "gray" || Boolean(selective),
    );
    // A decisive red rejects the proposal without requesting any gray judgments.
    if (routing.state === "red") {
      cascade.verdict = "fail";
      cascade.complete = true;
    }
    return {
      ...partitioned,
      reference: overall(
        cascadeCriteria.map((key) => reviewed.criteria[key].verdict),
      ),
      referenceCriteria: reviewed.criteria,
      jev,
      routing,
      baseline: baseline ?? null,
      selective: {
        criteria: routing.state === "gray" ? routing.grayCriteria : [],
        receipt: selective ?? null,
        mode:
          routing.state === "red"
            ? "auto-reject"
            : routing.state === "green"
              ? "auto-allow"
              : routing.state === "error"
                ? "jev-error"
                : selective
                  ? "judged"
                  : "pending",
      },
      arms: {
        jevOnly: arm(
          criteriaRecord((key) =>
            result
              ? result.answers[key] >= JEV_CONSOLIDATION_THRESHOLDS[key]
                ? "pass"
                : "fail"
              : "error",
          ),
        ),
        kimiOnly: arm(
          criteriaRecord(
            (key) => baselineResult?.judgments[key]?.verdict ?? "error",
          ),
          Boolean(baseline),
        ),
        cascade,
      },
    };
  });
  const selected = [...receipts.values()].filter(
    (receipt) => stage === "kimi" || receipt.kind === "jev",
  );
  const jev = selected.filter((receipt) => receipt.kind === "jev");
  const baseline = selected.filter(
    (receipt) => receipt.kind === "kimi-baseline",
  );
  const selective = selected.filter(
    (receipt) => receipt.kind === "kimi-selective",
  );
  return {
    status: selected.some((receipt) => receipt.outcome === "failed")
      ? ("completed_with_errors" as const)
      : ("completed" as const),
    stage,
    uniqueCases: cases.length,
    uniqueFamilies: new Set(partition.map((item) => item.familyId)).size,
    repetitions: 1,
    byCase,
    totals: {
      byCall: {
        jev: metrics(jev),
        kimiBaseline: metrics(baseline),
        kimiSelective: metrics(selective),
      },
      byArm: {
        jevOnly: metrics(jev),
        kimiOnly: metrics(baseline),
        cascade: metrics([...jev, ...selective]),
      },
      actual: metrics(selected),
      states: Object.fromEntries(
        ["red", "green", "gray", "error"].map((state) => [
          state,
          byCase.filter((item) => item.routing.state === state).length,
        ]),
      ),
      reusedCalls: 0,
    },
    caution:
      "Blind-subagent labels are an independent reference, not ground truth. Latencies sum request time, not elapsed wall time. Unknown usage and failed attempts are not zero cost; arm totals overlap because Jev is shared. No production gate was changed.",
  };
}

export async function runCascade(
  options: { input: string; stage: CascadeStage },
  dependencies: CascadeDependencies = {},
) {
  z.enum(["jev", "kimi"]).parse(options.stage);
  const directory = resolve(options.input);
  const lock = join(directory, ".cascade-run.lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    return invalid(
      "Experiment is locked; inspect interrupted work before resuming.",
    );
  }
  try {
    return await runLocked(directory, options.stage, dependencies);
  } finally {
    await rm(lock, { recursive: true });
  }
}
async function runLocked(
  directory: string,
  stage: CascadeStage,
  dependencies: CascadeDependencies,
) {
  const frozenArtifactNames = [...artifactNames];
  const texts = await Promise.all(
    artifactNames.map((name) => readFile(join(directory, name), "utf8")),
  );
  const cases = z
    .object({ cases: z.array(caseSchema).min(1) })
    .parse(JSON.parse(texts[0])).cases;
  const review = reviewSchema.parse(JSON.parse(texts[1]));
  const spec = z
    .object({
      repetitions: z.literal(1),
      expectedCases: z.number().int().positive().optional(),
      cases: z.number().int().positive().optional(),
      model: z.literal(JEV_MODEL).optional(),
      jevModel: z.literal(JEV_MODEL).optional(),
      kimiModel: z.literal(KIMI_MODEL).optional(),
      bandsHash: digest.optional(),
      method: z.unknown().optional(),
      independentFamilies: z.number().int().positive().optional(),
      originalThresholds: z.record(z.string(), z.number()).optional(),
      designCodeHashes: z.record(z.string(), digest),
    })
    .parse(JSON.parse(texts[2]));
  const rubricHash = hashCascadeText(texts[3]);
  const partition = partitionSchema.parse(JSON.parse(texts[4])).cases;
  const bands = bandsSchema.parse(JSON.parse(texts[5])).criteria;
  if (spec.bandsHash && spec.bandsHash !== hashCascadeText(texts[5]))
    invalid("Frozen bands hash differs from specification.");
  const ancillaryNames = ["development.json", "method.json"];
  const ancillaryTexts = await Promise.all(
    ancillaryNames.map((name) => optional(join(directory, name))),
  );
  ancillaryTexts.forEach((text, index) => {
    if (text !== undefined) {
      frozenArtifactNames.push(ancillaryNames[index]);
      texts.push(text);
    }
  });
  if (
    spec.originalThresholds &&
    (Object.keys(spec.originalThresholds).length !== 4 ||
      cascadeCriteria.some(
        (key) =>
          spec.originalThresholds?.[key] !== JEV_CONSOLIDATION_THRESHOLDS[key],
      ))
  )
    invalid("Specification original thresholds differ.");
  if (
    spec.independentFamilies !== undefined &&
    new Set(partition.map((item) => item.familyId)).size !==
      spec.independentFamilies
  )
    invalid("Specification family count differs.");
  if (
    (spec.expectedCases !== undefined && spec.expectedCases !== cases.length) ||
    (spec.cases !== undefined && spec.cases !== cases.length)
  )
    invalid("Specification case count differs.");
  if (
    cascadeHash(JSON.parse(texts[3])) !==
    cascadeHash(CONSOLIDATION_QUESTIONS_V2)
  )
    invalid("Rubric differs from shared V2 questions.");
  if (review.rubricHash !== rubricHash)
    invalid("Blind review rubric hash differs.");
  const ids = new Set(cases.map((item) => item.caseId));
  if (ids.size !== cases.length) invalid("Duplicate case identifiers.");
  for (const item of cases)
    if (cascadeHash(item.input) !== item.inputHash)
      invalid("Case input hash differs.");
  const remaining = new Map(cases.map((item) => [item.caseId, item.inputHash]));
  if (review.candidates.length !== cases.length)
    invalid("Every case requires exactly one blind review.");
  for (const item of review.candidates) {
    if (remaining.get(item.caseId) !== item.inputHash)
      invalid("Blind review membership differs.");
    remaining.delete(item.caseId);
  }
  const variants = new Set<string>();
  if (partition.length !== cases.length)
    invalid("Partition membership differs.");
  for (const item of partition) {
    if (!ids.delete(item.caseId)) invalid("Partition membership differs.");
    const key = JSON.stringify([item.familyId, item.variantId]);
    if (variants.has(key)) invalid("Duplicate family variant.");
    variants.add(key);
  }
  const codeNames = [
    ...new Set([
      "scripts/evaluate-consolidation-cascade.ts",
      "lib/maintenance/kimi-evaluator.ts",
      "lib/maintenance/consolidation-policy.ts",
      "lib/maintenance/jev.ts",
      "package.json",
      "pnpm-lock.yaml",
      "lib/maintenance/gateway.ts",
      "lib/maintenance/consolidation-rubric.ts",
      ...Object.keys(spec.designCodeHashes),
    ]),
  ];
  const codeHashes = Object.fromEntries(
    await Promise.all(
      codeNames.map(async (name) => {
        const path = resolve(root, name);
        if (!path.startsWith(`${root}/`))
          invalid("Design code must be inside this repository.");
        const hash = hashCascadeText(await readFile(path));
        if (spec.designCodeHashes[name] && spec.designCodeHashes[name] !== hash)
          invalid("Frozen design code hash differs.");
        return [name, hash];
      }),
    ),
  );
  const preparationPath = "scripts/prepare-consolidation-cascade.ts";
  if (spec.bandsHash || spec.designCodeHashes[preparationPath]) {
    const savedBands = JSON.parse(texts[5]);
    if (
      !spec.designCodeHashes[preparationPath] ||
      savedBands.preparationCodeHash !== spec.designCodeHashes[preparationPath]
    )
      invalid("Bands preparation code differs from frozen design.");
    const developmentText = ancillaryTexts[0];
    const methodText = ancillaryTexts[1];
    if (!developmentText || !methodText)
      invalid("Frozen bands require development and method artifacts.");
    const development = JSON.parse(developmentText);
    if (cascadeHash(development) !== savedBands.developmentHash)
      invalid("Frozen development hash differs.");
    const { deriveCascadeBands, CASCADE_METHOD } = await import(
      "./prepare-consolidation-cascade"
    );
    if (
      cascadeHash(deriveCascadeBands(development.cases).criteria) !==
      cascadeHash(savedBands.criteria)
    )
      invalid("Frozen bands differ from development-derived criteria.");
    if (
      cascadeHash(JSON.parse(methodText)) !== cascadeHash(CASCADE_METHOD) ||
      (spec.method !== undefined &&
        cascadeHash(spec.method) !== cascadeHash(CASCADE_METHOD))
    )
      invalid("Frozen selection method differs.");
  }
  const frozen = {
    version: 1,
    artifactHashes: Object.fromEntries(
      frozenArtifactNames.map((name, index) => [
        name,
        hashCascadeText(texts[index]),
      ]),
    ),
    codeHashes,
    questions: CONSOLIDATION_QUESTIONS_V2,
    thresholds: JEV_CONSOLIDATION_THRESHOLDS,
    bands,
    models: { jev: JEV_MODEL, kimi: KIMI_MODEL },
    kimiSettings: KIMI_EVALUATOR_SETTINGS,
    repetitions: 1,
    concurrency: 3,
    maxAttempts: 3,
    order:
      "Jev stage completes before Kimi; three case workers; even zero-based case index baseline then selective, odd selective then baseline; no call reuse",
  };
  const protocolPath = join(directory, "protocol.json");
  const oldProtocol = await optional(protocolPath);
  const existing = await readdir(directory);
  if (
    !oldProtocol &&
    existing.some(
      (name) =>
        name === "receipts" ||
        name === "kimi-protocol.json" ||
        name.startsWith("summary-"),
    )
  )
    invalid("Results exist without the original frozen protocol.");
  const protocol = oldProtocol
    ? JSON.parse(oldProtocol)
    : { frozenAt: new Date().toISOString(), ...frozen };
  const { frozenAt, ...savedFrozen } = protocol;
  if (!validTime(frozenAt) || cascadeHash(savedFrozen) !== cascadeHash(frozen))
    invalid("Frozen experiment inputs, code or settings changed.");
  if (dependencies.verifyOnly && !oldProtocol)
    invalid(
      "Verification requires a complete saved stage; no provider calls were made.",
    );
  await chmod(directory, 0o700);
  await Promise.all(
    frozenArtifactNames.map((name) => chmod(join(directory, name), 0o600)),
  );
  if (!oldProtocol) await save(protocolPath, protocol, true);
  const protocolHash = cascadeHash(protocol);
  const reviewHash = hashCascadeText(texts[1]);
  const receiptDirectory = join(directory, "receipts");
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  const entries = await readdir(receiptDirectory);
  const receipts = new Map<string, CascadeReceipt>();
  const journals = new Map<string, Journal>();
  const jevJobs = cases.map((_, index) => job(index, "jev"));
  let phaseProtocolHash = protocolHash;
  let phaseFrozenAt = frozenAt as string;
  function expectedFor(item: Job): Identity {
    return {
      ...item,
      caseId: cases[item.caseIndex].caseId,
      inputHash: cases[item.caseIndex].inputHash,
      protocolHash,
      phaseProtocolHash: item.kind === "jev" ? protocolHash : phaseProtocolHash,
      reviewHash,
      rubricHash,
      payloadHash: cascadeHash({
        input: cases[item.caseIndex].input,
        criteria: item.criteria,
        questions: Object.fromEntries(
          item.criteria.map((key) => [key, CONSOLIDATION_QUESTIONS_V2[key]]),
        ),
      }),
    };
  }
  const receiptPath = (item: Job) => join(receiptDirectory, `${item.id}.json`);
  async function loadJob(item: Job) {
    const [receiptText, journalText] = await Promise.all([
      optional(receiptPath(item)),
      optional(`${receiptPath(item)}.attempts`),
    ]);
    if (!receiptText && !journalText) return;
    if (!journalText) invalid("Saved receipt has no attempt journal.");
    const envelope = JSON.parse(journalText);
    const journal: Journal = envelope.journal;
    if (
      !journal ||
      envelope.journalHash !== cascadeHash(journal) ||
      journal.protocolHash !== protocolHash ||
      journal.jobHash !== cascadeHash(expectedFor(item)) ||
      !Array.isArray(journal.attempts) ||
      journal.attempts.length < 1 ||
      journal.attempts.length > 3
    )
      invalid("Saved attempt journal identity or hash differs.");
    let previousEnd = Date.parse(
      item.kind === "jev" ? frozenAt : phaseFrozenAt,
    );
    for (let index = 0; index < journal.attempts.length; index++) {
      const attempt = journal.attempts[index];
      if (
        !validTime(attempt.startedAt) ||
        Date.parse(attempt.startedAt) < previousEnd ||
        !["started", "success", "error"].includes(attempt.outcome)
      )
        invalid("Saved attempt chronology differs.");
      if (
        attempt.outcome !== "started" &&
        (!validTime(attempt.endedAt) ||
          Date.parse(attempt.endedAt) < Date.parse(attempt.startedAt) ||
          !number(attempt.latencyMs))
      )
        invalid("Invalid completed attempt chronology.");
      if (
        attempt.outcome === "started" &&
        (attempt.endedAt !== undefined ||
          attempt.latencyMs !== undefined ||
          attempt.error !== undefined)
      )
        invalid("Invalid started attempt metadata.");
      if (attempt.outcome === "error") validateError(attempt.error);
      if (attempt.outcome === "success" && attempt.error !== undefined)
        invalid("Successful attempt has error metadata.");
      if (
        index < journal.attempts.length - 1 &&
        (attempt.outcome !== "error" || !attempt.error?.retryable)
      )
        invalid("Saved retry order differs.");
      previousEnd = Date.parse(attempt.endedAt ?? attempt.startedAt);
    }
    journals.set(item.id, journal);
    const last = journal.attempts.at(-1) ?? invalid("Missing attempt journal.");
    if (!receiptText) {
      if (
        last.outcome !== "error" ||
        !last.error?.retryable ||
        journal.attempts.length >= 3
      )
        invalid(
          "Interrupted or unresolved outcome requires inspection; no duplicate request is allowed.",
        );
      return;
    }
    const saved = JSON.parse(receiptText);
    const receipt: CascadeReceipt = saved.receipt;
    if (!receipt || saved.receiptHash !== cascadeHash(receipt))
      invalid("Saved receipt hash differs.");
    const { evaluatedAt, attempts, latencyMs, outcome, ...rest } = receipt;
    const identity = { ...rest } as Record<string, unknown>;
    delete identity.result;
    delete identity.error;
    if (
      cascadeHash(identity) !== cascadeHash(expectedFor(item)) ||
      !validTime(evaluatedAt) ||
      Date.parse(evaluatedAt) < previousEnd ||
      attempts !== journal.attempts.length ||
      !number(latencyMs) ||
      !["success", "failed"].includes(outcome)
    )
      invalid("Saved receipt identity or chronology differs.");
    if (receipt.outcome === "success") {
      if (!["success", "started"].includes(last.outcome) || "error" in receipt)
        invalid("Success receipt conflicts with journal.");
      if (item.kind === "jev")
        validateJev(receipt.result as PositiveConsolidationEvaluation);
      else validateKimi(receipt.result as KimiEvaluation, item.criteria);
    } else {
      validateError(receipt.error);
      if (
        last.outcome !== "error" ||
        cascadeHash(last.error) !== cascadeHash(receipt.error) ||
        "result" in receipt ||
        (receipt.error.retryable && attempts < 3)
      )
        invalid("Failed receipt conflicts with journal.");
    }
    if (
      last.outcome !== "started" &&
      latencyMs !==
        journal.attempts.reduce(
          (sum, attempt) => sum + (attempt.latencyMs ?? 0),
          0,
        )
    )
      invalid("Saved receipt latency differs from attempts.");
    receipts.set(item.id, receipt);
  }
  await Promise.all(jevJobs.map(loadJob));
  const allJevResolved = jevJobs.every((item) => receipts.has(item.id));
  const oldPhase = await optional(join(directory, "kimi-protocol.json"));
  const oldJevSummary = await optional(join(directory, "summary-jev.json"));
  const oldKimiSummary = await optional(join(directory, "summary-kimi.json"));
  function checkSummary(text: string, forStage: CascadeStage) {
    const saved = JSON.parse(text);
    const { completedAt, protocolHash: savedHash, ...content } = saved;
    const relevant = [...receipts.values()].filter(
      (receipt) => forStage === "kimi" || receipt.kind === "jev",
    );
    if (
      !validTime(completedAt) ||
      savedHash !== protocolHash ||
      relevant.some(
        (receipt) => Date.parse(receipt.evaluatedAt) > Date.parse(completedAt),
      ) ||
      cascadeHash(content) !==
        cascadeHash(
          summarize(forStage, cases, review, partition, bands, receipts),
        )
    )
      invalid("Saved summary differs from receipts or chronology.");
    return saved;
  }
  if (oldJevSummary) {
    if (!allJevResolved)
      invalid("Jev summary exists with incomplete receipts.");
    checkSummary(oldJevSummary, "jev");
  }
  let groupedKimiJobs: Job[][] = [];
  if (
    stage === "kimi" ||
    oldPhase ||
    oldKimiSummary ||
    entries.some((entry) => entry.includes("-kimi-"))
  ) {
    if (!allJevResolved || !oldJevSummary)
      invalid("Kimi requires all Jev jobs resolved and the saved Jev summary.");
    const expectedPhase = {
      protocolHash,
      jevSummaryHash: hashCascadeText(oldJevSummary),
      jevReceiptHashes: Object.fromEntries(
        jevJobs.map((item) => [item.id, cascadeHash(receipts.get(item.id))]),
      ),
    };
    if (
      !oldPhase &&
      (oldKimiSummary || entries.some((entry) => entry.includes("-kimi-")))
    )
      invalid("Kimi results precede the frozen Kimi phase.");
    if (!oldPhase && dependencies.verifyOnly)
      invalid(
        "Verification requires a complete saved stage; no provider calls were made.",
      );
    const phase = oldPhase
      ? JSON.parse(oldPhase)
      : { frozenAt: new Date().toISOString(), ...expectedPhase };
    const { frozenAt: kimiFrozenAt, ...savedPhase } = phase;
    if (
      !validTime(kimiFrozenAt) ||
      Date.parse(kimiFrozenAt) <
        Date.parse(JSON.parse(oldJevSummary).completedAt) ||
      cascadeHash(savedPhase) !== cascadeHash(expectedPhase)
    )
      invalid("Frozen Kimi phase identity or chronology differs.");
    phaseProtocolHash = cascadeHash(phase);
    phaseFrozenAt = kimiFrozenAt;
    groupedKimiJobs = kimiJobs(cases, receipts, bands);
    await Promise.all(groupedKimiJobs.flat().map(loadJob));
    // Enforce each case's predeclared order even when other cases run concurrently.
    for (const group of groupedKimiJobs)
      if (group.length === 2) {
        const first = receipts.get(group[0].id);
        const second = journals.get(group[1].id);
        if (
          second &&
          (!first ||
            Date.parse(second.attempts[0].startedAt) <
              Date.parse(first.evaluatedAt))
        )
          invalid("Saved Kimi call order differs.");
      }
    if (!oldPhase)
      await save(join(directory, "kimi-protocol.json"), phase, true);
  }
  const allJobs = [...jevJobs, ...groupedKimiJobs.flat()];
  const allowedEntries = new Set(
    allJobs.flatMap((item) => [`${item.id}.json`, `${item.id}.json.attempts`]),
  );
  if (entries.some((entry) => !allowedEntries.has(entry)))
    invalid("Unexpected receipt artifact; inspect before resuming.");
  if (oldKimiSummary) {
    if (groupedKimiJobs.flat().some((item) => !receipts.has(item.id)))
      invalid("Kimi summary exists with incomplete receipts.");
    checkSummary(oldKimiSummary, "kimi");
  }
  const groups =
    stage === "jev" ? jevJobs.map((item) => [item]) : groupedKimiJobs;
  const selectedJobs = groups.flat();
  if (
    dependencies.verifyOnly &&
    selectedJobs.some((item) => !receipts.has(item.id))
  )
    invalid(
      "Verification requires a complete saved stage; no provider calls were made.",
    );
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((done) => setTimeout(done, milliseconds)));
  async function execute(item: Job) {
    if (receipts.has(item.id)) return;
    const path = receiptPath(item);
    const journal = journals.get(item.id) ?? {
      protocolHash,
      jobHash: cascadeHash(expectedFor(item)),
      attempts: [],
    };
    const saveJournal = () =>
      save(`${path}.attempts`, { journal, journalHash: cascadeHash(journal) });
    for (;;) {
      const attempt: Attempt = {
        startedAt: new Date().toISOString(),
        outcome: "started",
      };
      journal.attempts.push(attempt);
      await saveJournal();
      const started = performance.now();
      let result: PositiveConsolidationEvaluation | KimiEvaluation | undefined;
      let error: CascadeSafeError | undefined;
      let retryAfterMs: number | null = null;
      try {
        // Only the input and requested rubric criteria cross the provider boundary.
        if (item.kind === "jev") {
          result = applyPositiveConsolidationPolicy(
            await (dependencies.evaluateJev ?? evaluateConsolidationProposal)(
              cases[item.caseIndex].input,
              { questions: CONSOLIDATION_QUESTIONS_V2 },
            ),
          );
          validateJev(result);
        } else {
          result = await (dependencies.evaluateKimi ?? evaluateWithKimi)(
            cases[item.caseIndex].input,
            [...item.criteria],
          );
          validateKimi(result, item.criteria);
        }
      } catch (caught) {
        error = safeError(caught);
        retryAfterMs =
          caught instanceof GatewayRequestError ? caught.retryAfterMs : null;
      }
      const endedAt = new Date().toISOString();
      const elapsed = Math.max(0, Math.round(performance.now() - started));
      if (error) {
        Object.assign(attempt, {
          endedAt,
          latencyMs: elapsed,
          outcome: "error",
          error,
        });
        await saveJournal();
        if (error.retryable && journal.attempts.length < 3) {
          await sleep(
            Math.min(retryAfterMs ?? journal.attempts.length * 1000, 30_000),
          );
          continue;
        }
      }
      const receipt: CascadeReceipt = {
        ...expectedFor(item),
        evaluatedAt: endedAt,
        attempts: journal.attempts.length,
        latencyMs:
          journal.attempts
            .slice(0, -1)
            .reduce((sum, previous) => sum + (previous.latencyMs ?? 0), 0) +
          elapsed,
        ...(error
          ? { outcome: "failed" as const, error }
          : {
              outcome: "success" as const,
              result: result ?? invalid("Evaluation has no result."),
            }),
      };
      await save(path, { receipt, receiptHash: cascadeHash(receipt) }, true);
      if (!error) {
        Object.assign(attempt, {
          endedAt,
          latencyMs: elapsed,
          outcome: "success",
        });
        await saveJournal();
      }
      receipts.set(item.id, receipt);
      dependencies.progress?.({
        stage,
        completed: selectedJobs.filter((candidate) =>
          receipts.has(candidate.id),
        ).length,
        total: selectedJobs.length,
        failed: selectedJobs.filter(
          (candidate) => receipts.get(candidate.id)?.outcome === "failed",
        ).length,
      });
      return;
    }
  }
  let cursor = 0;
  let stop = false;
  // Await every worker even on filesystem failures before releasing the directory lock.
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(3, groups.length) }, async () => {
      try {
        while (!stop && cursor < groups.length) {
          const group = groups[cursor++];
          for (const item of group) {
            if (stop) return;
            await execute(item);
          }
        }
      } catch (error) {
        stop = true;
        throw error;
      }
    }),
  );
  for (const worker of workers)
    if (worker.status === "rejected") throw worker.reason;
  const oldSummary = stage === "jev" ? oldJevSummary : oldKimiSummary;
  if (oldSummary)
    return checkSummary(oldSummary, stage) as ReturnType<typeof summarize> & {
      protocolHash: string;
      completedAt: string;
    };
  const summary = {
    protocolHash,
    completedAt: new Date().toISOString(),
    ...summarize(stage, cases, review, partition, bands, receipts),
  };
  await save(join(directory, `summary-${stage}.json`), summary, true);
  return summary;
}
async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      stage: { type: "string" },
      "verify-only": { type: "boolean" },
    },
  });
  if (!values.input) invalid("Supply --input experiment directory.");
  const stage = z.enum(["jev", "kimi"]).parse(values.stage);
  loadEnvConfig(root);
  const summary = await runCascade(
    { input: values.input, stage },
    {
      verifyOnly: values["verify-only"],
      progress: (progress) => console.log(JSON.stringify(progress)),
    },
  );
  console.log(
    JSON.stringify({
      stage,
      status: summary.status,
      cases: summary.uniqueCases,
      jobs: summary.totals.actual.jobs,
      failed: summary.totals.actual.failedJobs,
    }),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main().catch(() => {
    console.error(
      "Cascade evaluation stopped; inspect the frozen artifacts and sanitized journals. No input or provider response text is logged.",
    );
    process.exitCode = 1;
  });
