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
  CONSOLIDATION_CRITERIA,
  CONSOLIDATION_QUESTIONS_V2,
  type ConsolidationCriterion,
  type ConsolidationQuestions,
} from "../lib/maintenance/consolidation-rubric";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import {
  type ConsolidationEvaluation,
  evaluateConsolidationProposal,
  JEV_MODEL,
} from "../lib/maintenance/jev";

// Offline experiment only. No database, document or production gate mutations.
export const defectVariants = ["positive", "negative", "defect"] as const;
export type DefectVariant = (typeof defectVariants)[number];
export type DefectPhase = "calibration" | "validation";
type Criterion = ConsolidationCriterion;
const phases = ["calibration", "validation"] as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const four = <T extends z.ZodType>(schema: T) =>
  z.strictObject({
    supported_by_evidence: schema,
    preserves_distinct_information: schema,
    no_new_human_action: schema,
    meaningful_improvement: schema,
  });
const questionSchema = four(
  z.strictObject({
    type: z.literal("boolean"),
    instructions: z.string().min(1),
    criteria: z.strictObject({
      true: z.string().min(1),
      false: z.string().min(1),
    }),
  }),
);
const caseSchema = z.strictObject({
  caseId: z.string().min(1),
  inputHash: digest,
  input: z.strictObject({
    before: z.unknown(),
    after: z.unknown(),
    evidence: z.unknown(),
    operation: z.unknown(),
  }),
});
const labelSchema = z.strictObject({
  verdict: z.enum(["pass", "fail", "uncertain"]),
  rationale: z.string().trim().min(1).max(10000),
});
const reviewSchema = z.object({
  reviewer: z.literal("blind-subagent"),
  rubricHash: digest,
  candidates: z.array(
    z.strictObject({
      caseId: z.string(),
      inputHash: digest,
      criteria: four(labelSchema),
    }),
  ),
});
const partitionSchema = z.object({
  cases: z.array(
    z.strictObject({
      caseId: z.string(),
      familyId: z.string().min(1),
      split: z.enum(phases),
      source: z.enum(["real", "synthetic-known", "synthetic-new"]),
      variantId: z.string().min(1),
    }),
  ),
});
type Case = z.infer<typeof caseSchema>;
type Partition = z.infer<typeof partitionSchema>["cases"];
type Review = z.infer<typeof reviewSchema>;
type Usage = ConsolidationEvaluation["usage"];
export type DefectSafeError = {
  class: "http" | "invalid_response" | "nonretryable" | "transport_or_unknown";
  status: number | null;
  retryable: boolean;
};
type Job = {
  id: string;
  caseIndex: number;
  phase: DefectPhase;
  variant: DefectVariant;
  repeat: number;
};
type Identity = Job & {
  caseId: string;
  inputHash: string;
  protocolHash: string;
  phaseHash: string;
  reviewHash: string;
  rubricHash: string;
  payloadHash: string;
};
export type DefectReceipt = Identity & {
  evaluatedAt: string;
  attempts: number;
  latencyMs: number;
  usage?: Usage;
} & (
    | {
        outcome: "success";
        rawScores: Record<Criterion, number>;
        risks: Record<Criterion, number>;
        model: string;
      }
    | { outcome: "failed"; error: DefectSafeError }
  );
type Attempt = {
  startedAt: string;
  endedAt?: string;
  latencyMs?: number;
  outcome: "started" | "success" | "error";
  error?: DefectSafeError;
};
type Journal = { protocolHash: string; jobHash: string; attempts: Attempt[] };
export type DefectDependencies = {
  evaluateJev?: typeof evaluateConsolidationProposal;
  verifyOnly?: boolean;
  sleep?: (ms: number) => Promise<void>;
  progress?: (value: {
    phase: DefectPhase;
    completed: number;
    total: number;
    failed: number;
  }) => void;
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactNames = [
  "cases.json",
  "subagent-review.json",
  "rubric.json",
  "partition.json",
  "questions.json",
  "evaluation-spec.json",
];
export function hashDefectText(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
export function defectHash(value: unknown) {
  return hashDefectText(JSON.stringify(value));
}
function invalid(message: string): never {
  throw new Error(message);
}
class InvalidEvaluation extends Error {}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function validTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value &&
    Date.parse(value) <= Date.now()
  );
}
function criteriaRecord<T>(get: (key: Criterion) => T) {
  return Object.fromEntries(
    CONSOLIDATION_CRITERIA.map((key) => [key, get(key)]),
  ) as Record<Criterion, T>;
}
export function normalizeDefectRisk(
  scores: Record<Criterion, number>,
  variant: DefectVariant,
) {
  return criteriaRecord((key) =>
    Number(
      (variant === "positive" ? 1 - scores[key] : scores[key]).toFixed(12),
    ),
  );
}
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
function safeUsage(value: unknown): Usage | undefined {
  const object = record(value);
  if (!object) return undefined;
  const usage: Usage = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const)
    if (number(object[key])) usage[key] = object[key];
  const gateway = record(object.gateway);
  for (const key of ["cost", "marketCost", "totalCost"] as const)
    if (number(gateway?.[key])) {
      usage.gateway ??= {};
      usage.gateway[key] = gateway[key];
    }
  return usage;
}
function scoresFrom(result: ConsolidationEvaluation) {
  const scores = four(z.number().min(0).max(1)).safeParse(result?.answers);
  if (!scores.success || result?.model !== JEV_MODEL || !record(result?.usage))
    throw new InvalidEvaluation();
  return scores.data;
}
function safeError(error: unknown): DefectSafeError {
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
function validateError(error: DefectSafeError | undefined) {
  if (
    !error ||
    ![
      "http",
      "invalid_response",
      "nonretryable",
      "transport_or_unknown",
    ].includes(error.class) ||
    typeof error.retryable !== "boolean" ||
    (error.class === "http") !== (error.status !== null) ||
    !(
      error.status === null ||
      (Number.isInteger(error.status) &&
        error.status >= 100 &&
        error.status <= 599)
    ) ||
    (error.retryable &&
      !(error.status === 429 || (error.status !== null && error.status >= 500)))
  )
    invalid("Invalid sanitized error.");
}
function groupsFor(
  cases: Case[],
  partition: Partition,
  phase: DefectPhase,
): Job[][] {
  const selected = new Set(
    partition.filter((item) => item.split === phase).map((item) => item.caseId),
  );
  return cases.flatMap((item, caseIndex) =>
    selected.has(item.caseId)
      ? [
          Array.from({ length: 3 }, (_, r) =>
            Array.from({ length: 3 }, (_, v) => {
              const variant = defectVariants[(caseIndex + r + v) % 3];
              return {
                id: `${phase}-${String(caseIndex + 1).padStart(4, "0")}-${r + 1}-${variant}`,
                caseIndex,
                phase,
                variant,
                repeat: r + 1,
              };
            }),
          ).flat(),
        ]
      : [],
  );
}
function metrics(input: DefectReceipt[]) {
  const receipts = [...input].sort((a, b) => a.id.localeCompare(b.id));
  const usage = Object.fromEntries(
    ["inputTokens", "outputTokens", "totalTokens", "costUsd"].map((key) => [
      key,
      { known: 0, missingJobs: 0 },
    ]),
  ) as Record<
    "inputTokens" | "outputTokens" | "totalTokens" | "costUsd",
    { known: number; missingJobs: number }
  >;
  for (const receipt of receipts)
    for (const key of Object.keys(usage) as (keyof typeof usage)[]) {
      const value =
        key === "costUsd"
          ? (receipt.usage?.gateway?.cost ?? receipt.usage?.gateway?.totalCost)
          : receipt.usage?.[key];
      if (number(value)) usage[key].known += value;
      else usage[key].missingJobs++;
    }
  return {
    jobs: receipts.length,
    requests: receipts.reduce((sum, r) => sum + r.attempts, 0),
    successfulJobs: receipts.filter((r) => r.outcome === "success").length,
    failedJobs: receipts.filter((r) => r.outcome === "failed").length,
    latencyMs: receipts.reduce((sum, r) => sum + r.latencyMs, 0),
    usage,
    unreportedAttemptUsage: receipts.reduce(
      (sum, r) => sum + r.attempts - Number(r.usage !== undefined),
      0,
    ),
  };
}
function summarize(
  phase: DefectPhase,
  cases: Case[],
  partition: Partition,
  review: Review,
  receipts: Map<string, DefectReceipt>,
) {
  const groups = groupsFor(cases, partition, phase);
  const selected = groups
    .flat()
    .map(
      (job) =>
        receipts.get(job.id) ?? invalid("Summary requires all resolved jobs."),
    );
  const byCase = groups.map((group) => {
    const item = cases[group[0].caseIndex];
    const metadata =
      partition.find((row) => row.caseId === item.caseId) ??
      invalid("Missing partition.");
    const reference =
      review.candidates.find((row) => row.caseId === item.caseId) ??
      invalid("Missing reference.");
    return {
      ...metadata,
      inputHash: item.inputHash,
      referenceCriteria: reference.criteria,
      receipts: Object.fromEntries(
        defectVariants.map((variant) => [
          variant,
          group
            .filter((job) => job.variant === variant)
            .map((job) => receipts.get(job.id) ?? invalid("Missing receipt.")),
        ]),
      ) as Record<DefectVariant, DefectReceipt[]>,
    };
  });
  return {
    status: selected.some((r) => r.outcome === "failed")
      ? ("completed_with_errors" as const)
      : ("completed" as const),
    phase,
    uniqueCases: byCase.length,
    uniqueFamilies: new Set(byCase.map((row) => row.familyId)).size,
    repetitions: 3,
    byCase,
    totals: {
      byVariant: Object.fromEntries(
        defectVariants.map((variant) => [
          variant,
          metrics(selected.filter((r) => r.variant === variant)),
        ]),
      ),
      actual: metrics(selected),
    },
    caution:
      "Independent labels are a reference, not ground truth. Normalized risk is a model score, not measured error probability. Failed calls are neither positive nor negative judgments; unknown usage is not zero cost. No production gate changed.",
  };
}
export async function runDefects(
  options: { input: string; phase: DefectPhase },
  dependencies: DefectDependencies = {},
) {
  z.enum(phases).parse(options.phase);
  const directory = resolve(options.input),
    lock = join(directory, ".jev-defects.lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    invalid("Experiment locked; inspect interrupted work before resuming.");
  }
  try {
    return await runLocked(directory, options.phase, dependencies);
  } finally {
    await rm(lock, { recursive: true });
  }
}
async function runLocked(
  directory: string,
  phase: DefectPhase,
  dependencies: DefectDependencies,
) {
  const texts = await Promise.all(
    artifactNames.map((name) => readFile(join(directory, name), "utf8")),
  );
  const cases = z
    .object({ cases: z.array(caseSchema).min(1) })
    .parse(JSON.parse(texts[0])).cases;
  const review = reviewSchema.parse(JSON.parse(texts[1]));
  const rubricHash = hashDefectText(texts[2]);
  const partition = partitionSchema.parse(JSON.parse(texts[3])).cases;
  const questions = z
    .strictObject({
      positive: questionSchema,
      negative: questionSchema,
      defect: questionSchema,
    })
    .parse(JSON.parse(texts[4]));
  const spec = z
    .object({
      repetitions: z.literal(3),
      expectedCalibrationCases: z.number().int().positive().optional(),
      expectedValidationCases: z.number().int().positive().optional(),
      expectedCases: z
        .strictObject({
          calibration: z.number().int().positive(),
          validation: z.number().int().positive(),
        })
        .optional(),
      model: z.literal(JEV_MODEL).optional(),
      designCodeHashes: z.record(z.string(), digest),
    })
    .parse(JSON.parse(texts[5]));
  if (
    defectHash(JSON.parse(texts[2])) !==
      defectHash(CONSOLIDATION_QUESTIONS_V2) ||
    defectHash(questions.positive) !== defectHash(CONSOLIDATION_QUESTIONS_V2)
  )
    invalid("Rubric or positive questions differ from shared V2.");
  if (review.rubricHash !== rubricHash) invalid("Review rubric hash differs.");
  const ids = new Set(cases.map((item) => item.caseId));
  if (
    ids.size !== cases.length ||
    review.candidates.length !== cases.length ||
    partition.length !== cases.length
  )
    invalid("Case, review or partition membership differs.");
  for (const item of cases)
    if (defectHash(item.input) !== item.inputHash)
      invalid("Case input hash differs.");
  const reviewed = new Map(cases.map((item) => [item.caseId, item.inputHash]));
  for (const item of review.candidates) {
    if (reviewed.get(item.caseId) !== item.inputHash)
      invalid("Review membership differs.");
    reviewed.delete(item.caseId);
  }
  const familySplit = new Map<string, DefectPhase>(),
    familyVariants = new Set<string>();
  for (const item of partition) {
    if (!ids.delete(item.caseId)) invalid("Partition membership differs.");
    if (
      familySplit.has(item.familyId) &&
      familySplit.get(item.familyId) !== item.split
    )
      invalid("Family crosses calibration and validation.");
    familySplit.set(item.familyId, item.split);
    const key = defectHash([item.familyId, item.variantId]);
    if (familyVariants.has(key)) invalid("Duplicate family variant.");
    familyVariants.add(key);
  }
  for (const p of phases) {
    const count = partition.filter((item) => item.split === p).length,
      expected =
        spec.expectedCases?.[p] ??
        (p === "calibration"
          ? spec.expectedCalibrationCases
          : spec.expectedValidationCases);
    if (count < 1 || (expected !== undefined && count !== expected))
      invalid("Specification phase case count differs.");
  }
  const codeNames = [
    ...new Set([
      "scripts/evaluate-jev-defects.ts",
      "lib/maintenance/defect-threshold-method.ts",
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
          invalid("Design code path outside repository.");
        const hash = hashDefectText(await readFile(path));
        if (spec.designCodeHashes[name] && spec.designCodeHashes[name] !== hash)
          invalid("Frozen design code changed.");
        return [name, hash];
      }),
    ),
  );
  const frozen = {
    version: 1,
    artifactHashes: Object.fromEntries(
      artifactNames.map((name, i) => [name, hashDefectText(texts[i])]),
    ),
    codeHashes,
    model: JEV_MODEL,
    repetitions: 3,
    concurrency: 3,
    maxAttempts: 3,
    riskOrientation: {
      positive: "1-score",
      negative: "score",
      defect: "score",
    },
    riskNormalization:
      "Round normalized risk to 12 decimal places in all arms; preserve raw score unchanged",
    order:
      "Three case workers; repeat 1..3; rotate positive/negative/defect by global zero-based case index plus zero-based repetition; calibration complete and selection frozen before validation",
  };
  const oldProtocol = await optional(join(directory, "protocol.json")),
    existing = await readdir(directory);
  if (
    !oldProtocol &&
    existing.some(
      (name) =>
        name === "receipts" ||
        name === "validation-protocol.json" ||
        name.startsWith("summary-"),
    )
  )
    invalid("Results exist without frozen protocol.");
  const protocol = oldProtocol
    ? JSON.parse(oldProtocol)
    : { frozenAt: new Date().toISOString(), ...frozen };
  const { frozenAt, ...savedFrozen } = protocol;
  if (!validTime(frozenAt) || defectHash(savedFrozen) !== defectHash(frozen))
    invalid("Frozen experiment inputs, code or settings changed.");
  if (dependencies.verifyOnly && !oldProtocol)
    invalid("Verification requires a saved complete phase; no requests made.");
  await chmod(directory, 0o700);
  await Promise.all(
    artifactNames.map((name) => chmod(join(directory, name), 0o600)),
  );
  if (!oldProtocol)
    await save(join(directory, "protocol.json"), protocol, true);
  const protocolHash = defectHash(protocol),
    reviewHash = hashDefectText(texts[1]);
  const receiptDirectory = join(directory, "receipts");
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  const entries = await readdir(receiptDirectory),
    receipts = new Map<string, DefectReceipt>(),
    journals = new Map<string, Journal>();
  const groups = {
    calibration: groupsFor(cases, partition, "calibration"),
    validation: groupsFor(cases, partition, "validation"),
  };
  const phaseHashes: Record<DefectPhase, string> = {
    calibration: protocolHash,
    validation: "",
  };
  const phaseTimes: Record<DefectPhase, string> = {
    calibration: frozenAt,
    validation: "",
  };
  const expectedFor = (item: Job): Identity => ({
    ...item,
    caseId: cases[item.caseIndex].caseId,
    inputHash: cases[item.caseIndex].inputHash,
    protocolHash,
    phaseHash: phaseHashes[item.phase],
    reviewHash,
    rubricHash,
    payloadHash: defectHash({
      input: cases[item.caseIndex].input,
      questions: questions[item.variant],
    }),
  });
  const receiptPath = (item: Job) => join(receiptDirectory, `${item.id}.json`);
  async function loadJob(item: Job) {
    const [receiptText, journalText] = await Promise.all([
      optional(receiptPath(item)),
      optional(`${receiptPath(item)}.attempts`),
    ]);
    if (!receiptText && !journalText) return;
    if (!journalText) invalid("Receipt has no attempt journal.");
    const envelope = JSON.parse(journalText),
      journal: Journal = envelope.journal;
    if (
      !journal ||
      envelope.journalHash !== defectHash(journal) ||
      journal.protocolHash !== protocolHash ||
      journal.jobHash !== defectHash(expectedFor(item)) ||
      !Array.isArray(journal.attempts) ||
      journal.attempts.length < 1 ||
      journal.attempts.length > 3
    )
      invalid("Journal identity or hash differs.");
    let previousEnd = Date.parse(phaseTimes[item.phase]);
    for (let index = 0; index < journal.attempts.length; index++) {
      const attempt = journal.attempts[index];
      if (
        !validTime(attempt.startedAt) ||
        Date.parse(attempt.startedAt) < previousEnd ||
        !["started", "success", "error"].includes(attempt.outcome)
      )
        invalid("Attempt chronology differs.");
      if (
        attempt.outcome !== "started" &&
        (!validTime(attempt.endedAt) ||
          Date.parse(attempt.endedAt) < Date.parse(attempt.startedAt) ||
          !number(attempt.latencyMs))
      )
        invalid("Completed attempt chronology differs.");
      if (
        attempt.outcome === "started" &&
        (attempt.endedAt !== undefined ||
          attempt.latencyMs !== undefined ||
          attempt.error !== undefined)
      )
        invalid("Started attempt metadata differs.");
      if (attempt.outcome === "error") validateError(attempt.error);
      if (attempt.outcome === "success" && attempt.error !== undefined)
        invalid("Success attempt contains error.");
      if (
        index < journal.attempts.length - 1 &&
        (attempt.outcome !== "error" || !attempt.error?.retryable)
      )
        invalid("Retry order differs.");
      previousEnd = Date.parse(attempt.endedAt ?? attempt.startedAt);
    }
    journals.set(item.id, journal);
    const last = journal.attempts.at(-1) ?? invalid("Missing attempt.");
    if (!receiptText) {
      if (
        last.outcome !== "error" ||
        !last.error?.retryable ||
        journal.attempts.length >= 3
      )
        invalid(
          "Interrupted or unresolved outcome requires inspection; no duplicate request allowed.",
        );
      return;
    }
    const saved = JSON.parse(receiptText),
      receipt: DefectReceipt = saved.receipt;
    if (!receipt || saved.receiptHash !== defectHash(receipt))
      invalid("Receipt hash differs.");
    const { evaluatedAt, attempts, latencyMs, outcome, usage, ...rest } =
      receipt;
    const identity = { ...rest } as Record<string, unknown>;
    for (const key of ["rawScores", "risks", "model", "error"])
      delete identity[key];
    if (
      defectHash(identity) !== defectHash(expectedFor(item)) ||
      !validTime(evaluatedAt) ||
      Date.parse(evaluatedAt) < previousEnd ||
      attempts !== journal.attempts.length ||
      !number(latencyMs) ||
      !["success", "failed"].includes(outcome) ||
      (usage !== undefined &&
        defectHash(usage) !== defectHash(safeUsage(usage)))
    )
      invalid("Receipt identity, usage or chronology differs.");
    if (receipt.outcome === "success") {
      if (
        !["success", "started"].includes(last.outcome) ||
        "error" in receipt ||
        receipt.model !== JEV_MODEL ||
        !four(z.number().min(0).max(1)).safeParse(receipt.rawScores).success ||
        defectHash(receipt.risks) !==
          defectHash(normalizeDefectRisk(receipt.rawScores, item.variant))
      )
        invalid("Successful receipt data or orientation differs.");
    } else {
      validateError(receipt.error);
      if (
        last.outcome !== "error" ||
        defectHash(last.error) !== defectHash(receipt.error) ||
        "rawScores" in receipt ||
        "risks" in receipt ||
        "model" in receipt ||
        (receipt.error.retryable && attempts < 3)
      )
        invalid("Failed receipt conflicts with journal.");
    }
    if (
      last.outcome !== "started" &&
      latencyMs !==
        journal.attempts.reduce((sum, a) => sum + (a.latencyMs ?? 0), 0)
    )
      invalid("Receipt latency differs.");
    receipts.set(item.id, receipt);
  }
  function validateGroupOrder(p: DefectPhase) {
    for (const group of groups[p])
      for (let i = 1; i < group.length; i++) {
        const later = journals.get(group[i].id),
          earlier = receipts.get(group[i - 1].id);
        if (
          later &&
          (!earlier ||
            Date.parse(later.attempts[0].startedAt) <
              Date.parse(earlier.evaluatedAt))
        )
          invalid("Saved per-case request order differs.");
      }
  }
  function checkSummary(text: string, p: DefectPhase) {
    const saved = JSON.parse(text),
      {
        completedAt,
        protocolHash: savedProtocol,
        phaseHash: savedPhase,
        ...content
      } = saved;
    if (
      !validTime(completedAt) ||
      savedProtocol !== protocolHash ||
      savedPhase !== phaseHashes[p] ||
      groups[p]
        .flat()
        .some(
          (job) =>
            !receipts.has(job.id) ||
            Date.parse(receipts.get(job.id)?.evaluatedAt ?? "") >
              Date.parse(completedAt),
        ) ||
      defectHash(content) !==
        defectHash(summarize(p, cases, partition, review, receipts))
    )
      invalid("Saved summary differs from receipts or chronology.");
    return saved as ReturnType<typeof summarize> & {
      protocolHash: string;
      phaseHash: string;
      completedAt: string;
    };
  }
  await Promise.all(groups.calibration.flat().map(loadJob));
  validateGroupOrder("calibration");
  const oldCalibration = await optional(
      join(directory, "summary-calibration.json"),
    ),
    oldValidation = await optional(join(directory, "summary-validation.json")),
    oldValidationPhase = await optional(
      join(directory, "validation-protocol.json"),
    );
  if (oldCalibration) checkSummary(oldCalibration, "calibration");
  const needsValidation =
    phase === "validation" ||
    Boolean(oldValidationPhase) ||
    Boolean(oldValidation) ||
    entries.some((name) => name.startsWith("validation-"));
  if (needsValidation) {
    if (
      !oldCalibration ||
      groups.calibration.flat().some((job) => !receipts.has(job.id))
    )
      invalid("Validation requires complete calibration and saved summary.");
    const selectionText = await optional(join(directory, "selection.json"));
    if (!selectionText) invalid("Validation requires frozen selection.json.");
    const selection = z
      .object({
        version: z.literal(1),
        calibrationSummaryHash: digest,
        protocolHash: digest,
        method: z.unknown(),
        criteria: z.unknown(),
      })
      .parse(JSON.parse(selectionText));
    if (
      selection.calibrationSummaryHash !== hashDefectText(oldCalibration) ||
      selection.protocolHash !== protocolHash
    )
      invalid("Selection does not bind this calibration summary and protocol.");
    const { selectThresholds, SELECTION_METHOD } = await import(
      "../lib/maintenance/defect-threshold-method"
    );
    if (
      defectHash(selection.method) !== defectHash(SELECTION_METHOD) ||
      defectHash(selection.criteria) !==
        defectHash(selectThresholds(JSON.parse(oldCalibration).byCase))
    )
      invalid(
        "Selection differs from the frozen method or derived calibration thresholds.",
      );
    const expectedPhase = {
      protocolHash,
      calibrationSummaryHash: hashDefectText(oldCalibration),
      selectionHash: hashDefectText(selectionText),
    };
    if (
      !oldValidationPhase &&
      (oldValidation || entries.some((name) => name.startsWith("validation-")))
    )
      invalid("Validation results precede frozen selection.");
    if (!oldValidationPhase && dependencies.verifyOnly)
      invalid(
        "Verification requires saved validation phase; no requests made.",
      );
    const phaseProtocol = oldValidationPhase
      ? JSON.parse(oldValidationPhase)
      : { frozenAt: new Date().toISOString(), ...expectedPhase };
    const { frozenAt: phaseFrozenAt, ...savedPhase } = phaseProtocol;
    if (
      !validTime(phaseFrozenAt) ||
      Date.parse(phaseFrozenAt) <
        Date.parse(JSON.parse(oldCalibration).completedAt) ||
      defectHash(savedPhase) !== defectHash(expectedPhase)
    )
      invalid("Frozen validation phase or selection changed.");
    phaseHashes.validation = defectHash(phaseProtocol);
    phaseTimes.validation = phaseFrozenAt;
    await Promise.all(groups.validation.flat().map(loadJob));
    validateGroupOrder("validation");
    if (oldValidation) checkSummary(oldValidation, "validation");
    if (!oldValidationPhase) {
      await chmod(join(directory, "selection.json"), 0o600);
      await save(
        join(directory, "validation-protocol.json"),
        phaseProtocol,
        true,
      );
    }
  }
  const allowed = new Set(
    [
      ...groups.calibration.flat(),
      ...(needsValidation ? groups.validation.flat() : []),
    ].flatMap((job) => [`${job.id}.json`, `${job.id}.json.attempts`]),
  );
  if (entries.some((name) => !allowed.has(name)))
    invalid("Unexpected receipt artifact.");
  const selectedJobs = groups[phase].flat();
  if (
    dependencies.verifyOnly &&
    selectedJobs.some((job) => !receipts.has(job.id))
  )
    invalid("Verification requires complete saved phase; no requests made.");
  const sleep =
    dependencies.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  async function execute(item: Job) {
    if (receipts.has(item.id)) return;
    const path = receiptPath(item),
      journal = journals.get(item.id) ?? {
        protocolHash,
        jobHash: defectHash(expectedFor(item)),
        attempts: [],
      };
    const saveJournal = () =>
      save(`${path}.attempts`, { journal, journalHash: defectHash(journal) });
    for (;;) {
      const attempt: Attempt = {
        startedAt: new Date().toISOString(),
        outcome: "started",
      };
      journal.attempts.push(attempt);
      await saveJournal();
      const started = performance.now();
      let result: ConsolidationEvaluation | undefined,
        scores: Record<Criterion, number> | undefined,
        error: DefectSafeError | undefined,
        retryAfterMs: number | null = null;
      try {
        result = await (
          dependencies.evaluateJev ?? evaluateConsolidationProposal
        )(cases[item.caseIndex].input, {
          questions: questions[item.variant] as ConsolidationQuestions,
        });
        scores = scoresFrom(result);
      } catch (caught) {
        error = safeError(caught);
        retryAfterMs =
          caught instanceof GatewayRequestError ? caught.retryAfterMs : null;
      }
      const endedAt = new Date().toISOString(),
        elapsed = Math.max(0, Math.round(performance.now() - started));
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
            Math.min(retryAfterMs ?? journal.attempts.length * 1000, 30000),
          );
          continue;
        }
      }
      const usage = safeUsage(result?.usage);
      const receipt: DefectReceipt = {
        ...expectedFor(item),
        evaluatedAt: endedAt,
        attempts: journal.attempts.length,
        latencyMs:
          journal.attempts
            .slice(0, -1)
            .reduce((sum, a) => sum + (a.latencyMs ?? 0), 0) + elapsed,
        ...(usage ? { usage } : {}),
        ...(error
          ? { outcome: "failed" as const, error }
          : {
              outcome: "success" as const,
              rawScores: scores ?? invalid("Missing scores."),
              risks: normalizeDefectRisk(
                scores ?? invalid("Missing scores."),
                item.variant,
              ),
              model: JEV_MODEL,
            }),
      };
      await save(path, { receipt, receiptHash: defectHash(receipt) }, true);
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
        phase,
        completed: selectedJobs.filter((job) => receipts.has(job.id)).length,
        total: selectedJobs.length,
        failed: selectedJobs.filter(
          (job) => receipts.get(job.id)?.outcome === "failed",
        ).length,
      });
      return;
    }
  }
  let cursor = 0,
    stop = false;
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(3, groups[phase].length) }, async () => {
      try {
        while (!stop && cursor < groups[phase].length) {
          const group = groups[phase][cursor++];
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
  const oldSummary = phase === "calibration" ? oldCalibration : oldValidation;
  if (oldSummary) return checkSummary(oldSummary, phase);
  const summary = {
    protocolHash,
    phaseHash: phaseHashes[phase],
    completedAt: new Date().toISOString(),
    ...summarize(phase, cases, partition, review, receipts),
  };
  await save(join(directory, `summary-${phase}.json`), summary, true);
  return summary;
}
async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      phase: { type: "string" },
      "verify-only": { type: "boolean" },
    },
  });
  if (!values.input) invalid("Supply --input experiment directory.");
  const phase = z.enum(phases).parse(values.phase);
  loadEnvConfig(root);
  const summary = await runDefects(
    { input: values.input, phase },
    {
      verifyOnly: values["verify-only"],
      progress: (value) => console.log(JSON.stringify(value)),
    },
  );
  console.log(
    JSON.stringify({
      phase,
      status: summary.status,
      cases: summary.uniqueCases,
      ...summary.totals.actual,
    }),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main().catch(() => {
    console.error(
      "Jev defect evaluation stopped; inspect frozen artifacts and sanitized journals. No document or provider response text is logged.",
    );
    process.exitCode = 1;
  });
