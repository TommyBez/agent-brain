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
  type ConsolidationQuestions,
} from "../lib/maintenance/consolidation-rubric";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import {
  type ConsolidationEvaluation,
  type ConsolidationEvaluationInput,
  evaluateConsolidationProposal,
  JEV_CONSOLIDATION_THRESHOLDS,
  JEV_MODEL,
} from "../lib/maintenance/jev";

// Offline orchestration only: no generator, database, document writes or production gate.
export const controlledCriteria = CONSOLIDATION_CRITERIA;
export type ControlledPhase = "calibration" | "validation";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const phaseSchema = z.enum(["calibration", "validation"]);
const thresholdsSchema = z.strictObject({
  supported_by_evidence: z.number().min(0).max(1),
  preserves_distinct_information: z.number().min(0).max(1),
  no_new_human_action: z.number().min(0).max(1),
  meaningful_improvement: z.number().min(0).max(1),
});
const labelSchema = z.strictObject({
  verdict: z.enum(["pass", "fail", "uncertain"]),
  rationale: z.string().trim().min(1).max(10_000),
});
const reviewSchema = z.strictObject({
  reviewer: z.literal("blind-subagent"),
  rubricHash: digest,
  candidates: z.array(
    z.strictObject({
      caseId: z.string().min(1),
      inputHash: digest,
      criteria: z.strictObject({
        supported_by_evidence: labelSchema,
        preserves_distinct_information: labelSchema,
        no_new_human_action: labelSchema,
        meaningful_improvement: labelSchema,
      }),
    }),
  ),
});
const casesSchema = z.object({
  cases: z
    .array(
      z.object({
        caseId: z.string().min(1),
        inputHash: digest,
        input: z.strictObject({
          before: z.unknown(),
          after: z.unknown(),
          evidence: z.unknown(),
          operation: z.unknown(),
        }),
      }),
    )
    .min(1),
});
const partitionSchema = z.object({
  cases: z
    .array(
      z.strictObject({
        caseId: z.string().min(1),
        familyId: z.string().min(1),
        variantId: z.string().min(1),
        targetCriterion: z.enum(CONSOLIDATION_CRITERIA).nullable(),
        split: phaseSchema,
      }),
    )
    .min(1),
});
type Case = z.infer<typeof casesSchema>["cases"][number];
type Review = z.infer<typeof reviewSchema>;
type Partition = z.infer<typeof partitionSchema>["cases"];
type Thresholds = z.infer<typeof thresholdsSchema>;
type Job = {
  sequence: number;
  caseIndex: number;
  repeat: number;
  phase: ControlledPhase;
};
export type ControlledReceipt = Job & {
  caseId: string;
  inputHash: string;
  reviewHash: string;
  rubricHash: string;
  protocolHash: string;
  phaseProtocolHash: string;
  questionsHash: string;
  evaluatedAt: string;
  attempts: number;
  result: PositiveConsolidationEvaluation;
};
type Attempt = {
  startedAt: string;
  endedAt?: string;
  outcome: "started" | "success" | "error";
  retryable?: boolean;
  status?: number | null;
};
type Journal = {
  protocolHash: string;
  phaseProtocolHash: string;
  jobHash: string;
  attempts: Attempt[];
};
export type ControlledDependencies = {
  verifyOnly?: boolean;
  evaluate?: (
    input: ConsolidationEvaluationInput,
    options: { questions: ConsolidationQuestions },
  ) => Promise<ConsolidationEvaluation>;
  sleep?: (milliseconds: number) => Promise<void>;
  progress?: (progress: {
    phase: ControlledPhase;
    completed: number;
    total: number;
    knownCost: number;
  }) => void;
};

export function hashControlledText(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
export function controlledHash(value: unknown) {
  return hashControlledText(JSON.stringify(value));
}
function invalid(message: string): never {
  throw new Error(message);
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
function validTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
const artifactNames = [
  "cases.json",
  "subagent-review.json",
  "evaluation-spec.json",
  "rubric.json",
  "partition.json",
];

export function controlledJobs(
  cases: Case[],
  partition: Partition,
  phase: ControlledPhase,
): Job[] {
  const selected = new Set(
    partition.filter((item) => item.split === phase).map((item) => item.caseId),
  );
  const jobs: Job[] = [];
  // Keep a case's three repeats adjacent; provider requests are always serial.
  cases.forEach((item, caseIndex) => {
    if (selected.has(item.caseId))
      for (let repeat = 1; repeat <= 3; repeat++)
        jobs.push({ sequence: jobs.length + 1, caseIndex, repeat, phase });
  });
  return jobs;
}
function validateMembership(
  cases: Case[],
  review: Review,
  partition: Partition,
  rubricHash: string,
) {
  const ids = new Set(cases.map((item) => item.caseId));
  if (ids.size !== cases.length) invalid("Duplicate case identifiers.");
  if (review.rubricHash !== rubricHash)
    invalid("Blind review rubric hash differs.");
  const remaining = new Map(cases.map((item) => [item.caseId, item.inputHash]));
  if (review.candidates.length !== cases.length)
    invalid("Every case must have exactly one blind review.");
  for (const item of review.candidates) {
    if (remaining.get(item.caseId) !== item.inputHash)
      invalid("Blind review membership or input hash differs.");
    remaining.delete(item.caseId);
  }
  if (remaining.size) invalid("Blind review is incomplete.");
  const families = new Map<string, ControlledPhase>();
  const variants = new Set<string>();
  if (partition.length !== cases.length)
    invalid("Partition membership differs.");
  for (const item of partition) {
    if (!ids.delete(item.caseId)) invalid("Partition membership differs.");
    if (
      families.has(item.familyId) &&
      families.get(item.familyId) !== item.split
    )
      invalid("Calibration and validation families must be disjoint.");
    families.set(item.familyId, item.split);
    const key = JSON.stringify([item.familyId, item.variantId]);
    if (variants.has(key)) invalid("Duplicate variant within a family.");
    variants.add(key);
  }
  if (
    ids.size ||
    !partition.some((item) => item.split === "calibration") ||
    !partition.some((item) => item.split === "validation")
  )
    invalid(
      "Both complete calibration and validation partitions are required.",
    );
}
function validateResult(result: PositiveConsolidationEvaluation) {
  if (
    !result ||
    result.model !== JEV_MODEL ||
    !result.answers ||
    Object.keys(result.answers).length !== controlledCriteria.length ||
    controlledCriteria.some(
      (key) =>
        !Number.isFinite(result.answers[key]) ||
        result.answers[key] < 0 ||
        result.answers[key] > 1,
    )
  )
    invalid("Invalid evaluation scores or model.");
  if (
    result.allowed !==
    controlledCriteria.every(
      (key) => result.answers[key] >= JEV_CONSOLIDATION_THRESHOLDS[key],
    )
  )
    invalid("Evaluation decision differs from default thresholds.");
  if (
    !result.usage ||
    Object.values(result.usage.gateway ?? {}).some(
      (value) => !Number.isFinite(value) || value < 0,
    )
  )
    invalid("Invalid evaluation usage.");
}
function receiptCost(receipt: ControlledReceipt) {
  return (
    receipt.result.usage.gateway?.cost ??
    receipt.result.usage.gateway?.totalCost ??
    null
  );
}
function reference(
  item: Review["candidates"][number],
): "pass" | "fail" | "uncertain" {
  const labels = controlledCriteria.map((key) => item.criteria[key].verdict);
  return labels.includes("fail")
    ? "fail"
    : labels.includes("uncertain")
      ? "uncertain"
      : "pass";
}
export function summarizeControlled(
  cases: Case[],
  review: Review,
  partition: Partition,
  receipts: ControlledReceipt[],
  phase: ControlledPhase,
  selectedThresholds?: Thresholds,
) {
  const reviews = new Map(review.candidates.map((item) => [item.caseId, item]));
  const selected = partition.filter((item) => item.split === phase);
  const byCase = selected.map((item) => {
    const runs = receipts
      .filter((run) => run.caseId === item.caseId)
      .sort((a, b) => a.repeat - b.repeat);
    if (
      runs.length !== 3 ||
      runs.some((run, index) => run.repeat !== index + 1)
    )
      invalid("Analysis requires three completed repeats per case.");
    const reviewed = reviews.get(item.caseId);
    if (!reviewed) return invalid("Missing blind reference.");
    const passCount = runs.filter((run) => run.result.allowed).length;
    return {
      ...item,
      reference: reference(reviewed),
      passCount,
      decisions: runs.map((run) => run.result.allowed),
      flips: passCount > 0 && passCount < 3,
      criteria: Object.fromEntries(
        controlledCriteria.map((key) => {
          const scores = runs.map((run) => run.result.answers[key]);
          const sorted = [...scores].sort((a, b) => a - b);
          const criterionPassCount = scores.filter(
            (score) => score >= JEV_CONSOLIDATION_THRESHOLDS[key],
          ).length;
          return [
            key,
            {
              reference: reviewed.criteria[key].verdict,
              scores,
              min: sorted[0],
              median: sorted[1],
              max: sorted[2],
              passCount: criterionPassCount,
              flips: criterionPassCount > 0 && criterionPassCount < 3,
            },
          ];
        }),
      ) as Record<
        ConsolidationCriterion,
        {
          reference: "pass" | "fail" | "uncertain";
          scores: number[];
          min: number;
          median: number;
          max: number;
          passCount: number;
          flips: boolean;
        }
      >,
      ...(selectedThresholds
        ? {
            calibratedDecisions: runs.map((run) =>
              controlledCriteria.every(
                (key) => run.result.answers[key] >= selectedThresholds[key],
              ),
            ),
          }
        : {}),
    };
  });
  if (byCase.length * 3 !== receipts.length || cases.length < byCase.length)
    invalid("Receipt membership differs from phase.");
  return {
    status: "completed" as const,
    phase,
    uniqueCases: byCase.length,
    uniqueFamilies: new Set(selected.map((item) => item.familyId)).size,
    evaluations: receipts.length,
    repetitions: 3,
    thresholds: JEV_CONSOLIDATION_THRESHOLDS,
    ...(selectedThresholds ? { calibratedThresholds: selectedThresholds } : {}),
    byCase,
    casesWithDecisionFlips: byCase.filter((item) => item.flips).length,
    attempts: receipts.reduce((sum, item) => sum + item.attempts, 0),
    cost: {
      known: receipts.reduce((sum, item) => sum + (receiptCost(item) ?? 0), 0),
      missingReceipts: receipts.filter((item) => receiptCost(item) === null)
        .length,
      note: "Successful receipts only; failed or interrupted attempts may incur unreported charges.",
    },
    caution:
      "Blind-subagent labels are a reference, not ground truth. Repeats measure stability of the same cases, not independent examples. Threshold selection is restricted to calibration families.",
  };
}

export async function runControlled(
  options: { input: string; phase: ControlledPhase },
  dependencies: ControlledDependencies = {},
) {
  phaseSchema.parse(options.phase);
  const directory = resolve(options.input);
  // An interrupted process leaves this lock for explicit inspection, never a duplicate request.
  const lock = join(directory, ".controlled-run.lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    return invalid(
      "Experiment is locked; inspect any interrupted process before resuming.",
    );
  }
  try {
    return await runLocked(directory, options.phase, dependencies);
  } finally {
    await rm(lock, { recursive: true });
  }
}
async function runLocked(
  directory: string,
  phase: ControlledPhase,
  dependencies: ControlledDependencies,
) {
  const texts = await Promise.all(
    artifactNames.map((name) => readFile(join(directory, name), "utf8")),
  );
  const cases = casesSchema.parse(JSON.parse(texts[0])).cases;
  const review = reviewSchema.parse(JSON.parse(texts[1]));
  const spec = z
    .object({
      repetitions: z.literal(3),
      cases: z.number().int().positive().optional(),
      model: z.literal(JEV_MODEL).optional(),
      thresholds: thresholdsSchema.optional(),
      designCodeHashes: z.record(z.string(), digest).optional(),
      selectionRule: z.unknown().optional(),
      independentFamilies: z.number().int().positive().optional(),
      calibrationFamilies: z.number().int().positive().optional(),
      validationFamilies: z.number().int().positive().optional(),
    })
    .parse(JSON.parse(texts[2]));
  const partition = partitionSchema.parse(JSON.parse(texts[4])).cases;
  if (spec.cases !== undefined && spec.cases !== cases.length)
    invalid("Specification case count differs.");
  if (
    spec.thresholds &&
    controlledCriteria.some(
      (key) => spec.thresholds?.[key] !== JEV_CONSOLIDATION_THRESHOLDS[key],
    )
  )
    invalid("Specification default thresholds differ.");
  for (const item of cases)
    if (controlledHash(item.input) !== item.inputHash)
      invalid("Case input hash differs.");
  const rubricHash = hashControlledText(texts[3]);
  if (
    controlledHash(JSON.parse(texts[3])) !==
    controlledHash(CONSOLIDATION_QUESTIONS_V2)
  )
    invalid("Rubric differs from shared V2 questions.");
  validateMembership(cases, review, partition, rubricHash);
  for (const [declared, entries] of [
    [spec.independentFamilies, partition],
    [
      spec.calibrationFamilies,
      partition.filter((item) => item.split === "calibration"),
    ],
    [
      spec.validationFamilies,
      partition.filter((item) => item.split === "validation"),
    ],
  ] as const) {
    if (
      declared !== undefined &&
      new Set(entries.map((item) => item.familyId)).size !== declared
    )
      invalid("Specification family count differs from the frozen partition.");
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const codeNames = [
    "scripts/evaluate-jev-controlled.ts",
    "lib/maintenance/consolidation-policy.ts",
    "lib/maintenance/jev.ts",
    "package.json",
    "pnpm-lock.yaml",
    "lib/maintenance/consolidation-rubric.ts",
    "lib/maintenance/gateway.ts",
  ];
  const codeHashes = Object.fromEntries(
    await Promise.all(
      codeNames.map(async (name) => [
        name,
        hashControlledText(await readFile(join(root, name))),
      ]),
    ),
  );
  for (const [name, expectedHash] of Object.entries(
    spec.designCodeHashes ?? {},
  )) {
    const path = resolve(root, name);
    if (!path.startsWith(`${root}/`))
      invalid("Design code must refer to a file inside this repository.");
    const actualHash = hashControlledText(await readFile(path));
    if (actualHash !== expectedHash)
      invalid("Frozen design code hash differs from current source.");
    codeHashes[name] = actualHash;
  }
  const frozen = {
    version: 1,
    artifactHashes: Object.fromEntries(
      artifactNames.map((name, index) => [
        name,
        hashControlledText(texts[index]),
      ]),
    ),
    codeHashes,
    questions: CONSOLIDATION_QUESTIONS_V2,
    thresholds: JEV_CONSOLIDATION_THRESHOLDS,
    model: JEV_MODEL,
    repetitions: 3,
    order:
      "case-major in cases.json order; three serial repeats per case; calibration before validation",
    maxAttempts: 3,
  };
  const protocolPath = join(directory, "protocol.json");
  const oldProtocol = await optional(protocolPath);
  if (!oldProtocol) {
    const existing = await readdir(directory);
    if (
      existing.some(
        (name) =>
          name === "receipts" ||
          name === "validation-protocol.json" ||
          name === "calibration.json" ||
          name.startsWith("summary-"),
      )
    )
      invalid("Experiment results exist without the original frozen protocol.");
  }
  const protocol = oldProtocol
    ? JSON.parse(oldProtocol)
    : { frozenAt: new Date().toISOString(), ...frozen };
  const { frozenAt, ...existingFrozen } = protocol;
  if (
    !validTime(frozenAt) ||
    controlledHash(existingFrozen) !== controlledHash(frozen)
  )
    invalid(
      "Frozen experiment inputs, partition, code or specification changed.",
    );
  await chmod(directory, 0o700);
  await Promise.all(
    artifactNames.map((name) => chmod(join(directory, name), 0o600)),
  );
  if (!oldProtocol) await save(protocolPath, protocol, true);
  const protocolHash = controlledHash(protocol);
  const reviewHash = hashControlledText(texts[1]);
  let validationProtocol:
    | {
        frozenAt: string;
        protocolHash: string;
        calibrationHash: string;
        thresholds: Thresholds;
      }
    | undefined;
  const calibrationText = await optional(join(directory, "calibration.json"));
  const oldValidation = await optional(
    join(directory, "validation-protocol.json"),
  );
  if (phase === "validation" || oldValidation) {
    if (!calibrationText)
      invalid(
        "Validation requires a frozen calibration.json threshold selection.",
      );
    const selection = z
      .object({ protocolHash: digest, thresholds: thresholdsSchema })
      .parse(JSON.parse(calibrationText));
    if (selection.protocolHash !== protocolHash)
      invalid("Calibration selection refers to another frozen protocol.");
    const expected = {
      protocolHash,
      calibrationHash: hashControlledText(calibrationText),
      thresholds: selection.thresholds,
    };
    const checkedValidationProtocol = z
      .strictObject({
        frozenAt: z.string(),
        protocolHash: digest,
        calibrationHash: digest,
        thresholds: thresholdsSchema,
      })
      .parse(
        oldValidation
          ? JSON.parse(oldValidation)
          : { frozenAt: new Date().toISOString(), ...expected },
      );
    validationProtocol = checkedValidationProtocol;
    const { frozenAt: selectionFrozenAt, ...saved } = checkedValidationProtocol;
    if (
      !validTime(selectionFrozenAt) ||
      Date.parse(selectionFrozenAt) < Date.parse(frozenAt) ||
      controlledHash(saved) !== controlledHash(expected)
    )
      invalid("Frozen validation selection changed.");
  }
  const receiptRoot = join(directory, "receipts");
  await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
  for (const name of await readdir(receiptRoot))
    if (!phaseSchema.safeParse(name).success)
      invalid("Unexpected receipt phase directory.");
  const byPhase = new Map<ControlledPhase, ControlledReceipt[]>();
  const journalByPhase = new Map<ControlledPhase, Map<number, Journal>>();
  const receiptName = (job: Job) =>
    `${String(job.sequence).padStart(4, "0")}.json`;
  const phaseHash = (forPhase: ControlledPhase) =>
    forPhase === "calibration"
      ? protocolHash
      : validationProtocol
        ? controlledHash(validationProtocol)
        : invalid(
            "Validation results exist before threshold selection was frozen.",
          );
  const phaseFrozenAt = (forPhase: ControlledPhase) =>
    forPhase === "calibration"
      ? frozenAt
      : (validationProtocol?.frozenAt ??
        invalid("Missing validation protocol."));
  const expectedFor = (job: Job) => ({
    ...job,
    caseId: cases[job.caseIndex].caseId,
    inputHash: cases[job.caseIndex].inputHash,
    reviewHash,
    rubricHash,
    protocolHash,
    phaseProtocolHash: phaseHash(job.phase),
    questionsHash: controlledHash(CONSOLIDATION_QUESTIONS_V2),
  });
  // Validate ALL existing receipts and journals, including later jobs, before any new call.
  for (const forPhase of ["calibration", "validation"] as const) {
    const jobs = controlledJobs(cases, partition, forPhase);
    const receiptDirectory = join(receiptRoot, forPhase);
    const entries = await readdir(receiptDirectory).catch((error) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    if (forPhase === "validation" && entries.length && !oldValidation)
      invalid("Validation receipts precede the frozen threshold selection.");
    const allowedFiles = new Set(
      jobs.flatMap((job) => [receiptName(job), `${receiptName(job)}.attempts`]),
    );
    if (entries.some((name) => !allowedFiles.has(name)))
      invalid("Unexpected receipt artifact; inspect before resuming.");
    const receipts: ControlledReceipt[] = [];
    const journals = new Map<number, Journal>();
    let incomplete = false;
    for (const job of jobs) {
      const path = join(receiptDirectory, receiptName(job));
      const [receiptText, journalText] = await Promise.all([
        optional(path),
        optional(`${path}.attempts`),
      ]);
      if (!receiptText && !journalText) {
        incomplete = true;
        continue;
      }
      if (incomplete)
        invalid("Saved requests violate the frozen serial order.");
      if (!journalText) invalid("Saved receipt has no attempt journal.");
      const envelope = JSON.parse(journalText);
      const journal: Journal = envelope.journal;
      if (
        !journal ||
        envelope.journalHash !== controlledHash(journal) ||
        journal.protocolHash !== protocolHash ||
        journal.phaseProtocolHash !== phaseHash(forPhase) ||
        journal.jobHash !== controlledHash(expectedFor(job)) ||
        !Array.isArray(journal.attempts) ||
        journal.attempts.length < 1 ||
        journal.attempts.length > 3
      )
        invalid("Saved attempt journal differs from frozen inputs or hash.");
      let previousEnd = Date.parse(phaseFrozenAt(forPhase));
      for (let index = 0; index < journal.attempts.length; index++) {
        const attempt = journal.attempts[index];
        if (
          !validTime(attempt.startedAt) ||
          Date.parse(attempt.startedAt) < previousEnd ||
          !["started", "success", "error"].includes(attempt.outcome)
        )
          invalid("Saved request chronology differs from the frozen protocol.");
        if (
          attempt.outcome !== "started" &&
          (!validTime(attempt.endedAt) ||
            Date.parse(attempt.endedAt) < Date.parse(attempt.startedAt))
        )
          invalid("Invalid completed attempt chronology.");
        if (
          index < journal.attempts.length - 1 &&
          (attempt.outcome !== "error" || !attempt.retryable)
        )
          invalid("Saved attempt retry order is invalid.");
        previousEnd = Date.parse(attempt.endedAt ?? attempt.startedAt);
      }
      journals.set(job.sequence, journal);
      const last = journal.attempts.at(-1);
      if (!receiptText) {
        incomplete = true;
        if (last?.outcome !== "error" || !last.retryable)
          invalid(
            "An interrupted or non-retryable request has no saved result; manual inspection required.",
          );
        if (journal.attempts.length >= 3)
          invalid("The bounded request attempt limit was reached.");
        continue;
      }
      const saved = JSON.parse(receiptText);
      if (saved.receiptHash !== controlledHash(saved.receipt))
        invalid("Saved receipt hash differs.");
      const receipt: ControlledReceipt = saved.receipt;
      const { evaluatedAt, attempts, result, ...identity } = receipt;
      if (
        controlledHash(identity) !== controlledHash(expectedFor(job)) ||
        !validTime(evaluatedAt) ||
        Date.parse(evaluatedAt) < previousEnd ||
        attempts !== journal.attempts.length ||
        !last ||
        !["started", "success"].includes(last.outcome)
      )
        invalid(
          "Saved receipt refers to different frozen inputs or chronology.",
        );
      validateResult(result);
      receipts.push(receipt);
    }
    byPhase.set(forPhase, receipts);
    journalByPhase.set(forPhase, journals);
  }
  if (phase === "validation") {
    const calibrationReceipts = byPhase.get("calibration") ?? [];
    if (
      calibrationReceipts.length !==
      controlledJobs(cases, partition, "calibration").length
    )
      invalid("Complete calibration receipts are required before validation.");
    const calibrationSummaryText = await optional(
      join(directory, "summary-calibration.json"),
    );
    if (!calibrationSummaryText)
      invalid("Completed calibration summary is required before validation.");
    const {
      completedAt: calibrationCompletedAt,
      protocolHash: savedHash,
      phaseProtocolHash: savedPhaseHash,
      ...savedSummary
    } = JSON.parse(calibrationSummaryText);
    if (
      !validTime(calibrationCompletedAt) ||
      savedHash !== protocolHash ||
      savedPhaseHash !== protocolHash ||
      controlledHash(savedSummary) !==
        controlledHash(
          summarizeControlled(
            cases,
            review,
            partition,
            calibrationReceipts,
            "calibration",
          ),
        ) ||
      Date.parse(calibrationCompletedAt) >
        Date.parse(validationProtocol?.frozenAt ?? "")
    )
      invalid(
        "Calibration summary differs from validated receipts or chronology.",
      );
    const analyzerPath = "scripts/analyze-jev-controlled.ts";
    if (
      spec.designCodeHashes?.[analyzerPath] &&
      spec.selectionRule !== undefined
    ) {
      const selected = JSON.parse(calibrationText ?? "null");
      if (
        !selected ||
        selected.calibrationSummaryHash !==
          hashControlledText(calibrationSummaryText) ||
        selected.analysisCodeHash !== spec.designCodeHashes[analyzerPath] ||
        controlledHash(selected.rule) !== controlledHash(spec.selectionRule) ||
        !validTime(selected.selectedAt) ||
        Date.parse(selected.selectedAt) < Date.parse(calibrationCompletedAt) ||
        Date.parse(selected.selectedAt) >
          Date.parse(validationProtocol?.frozenAt ?? "")
      )
        invalid(
          "Frozen calibration selection does not match its summary, analysis code, rule or chronology.",
        );
      const { selectControlledThresholds } = await import(
        "./analyze-jev-controlled"
      );
      const recomputed = selectControlledThresholds(savedSummary.byCase);
      if (
        Object.entries(recomputed).some(
          ([key, value]) =>
            controlledHash(selected[key]) !== controlledHash(value),
        )
      )
        invalid(
          "Frozen thresholds or feasibility differ from the calibration-only selection rule.",
        );
    }
    await chmod(join(directory, "calibration.json"), 0o600);
    if (!oldValidation)
      await save(
        join(directory, "validation-protocol.json"),
        validationProtocol,
        true,
      );
  }
  const receiptDirectory = join(receiptRoot, phase);
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  const jobs = controlledJobs(cases, partition, phase);
  const receipts = byPhase.get(phase) ?? [];
  if (dependencies.verifyOnly && receipts.length !== jobs.length)
    invalid(
      "Verification requires complete saved receipts; no provider calls were made.",
    );
  const journals = journalByPhase.get(phase) ?? new Map<number, Journal>();
  const evaluate = dependencies.evaluate ?? evaluateConsolidationProposal;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((done) => setTimeout(done, milliseconds)));
  for (const job of jobs) {
    if (receipts.some((item) => item.sequence === job.sequence)) continue;
    const path = join(receiptDirectory, receiptName(job));
    const journal: Journal = journals.get(job.sequence) ?? {
      protocolHash,
      phaseProtocolHash: phaseHash(phase),
      jobHash: controlledHash(expectedFor(job)),
      attempts: [],
    };
    const saveJournal = () =>
      save(`${path}.attempts`, {
        journal,
        journalHash: controlledHash(journal),
      });
    for (;;) {
      const attempt: Attempt = {
        startedAt: new Date().toISOString(),
        outcome: "started",
      };
      journal.attempts.push(attempt);
      await saveJournal();
      let result: PositiveConsolidationEvaluation;
      try {
        result = applyPositiveConsolidationPolicy(
          await evaluate(cases[job.caseIndex].input, {
            questions: CONSOLIDATION_QUESTIONS_V2,
          }),
        );
        validateResult(result);
      } catch (error) {
        const retryable =
          error instanceof GatewayRequestError && error.retryable;
        Object.assign(attempt, {
          endedAt: new Date().toISOString(),
          outcome: "error",
          retryable,
          status: error instanceof GatewayRequestError ? error.status : null,
        });
        await saveJournal();
        if (!retryable || journal.attempts.length >= 3)
          invalid("Evaluation failed; sanitized attempt metadata was saved.");
        await sleep(
          Math.min(
            (error as GatewayRequestError).retryAfterMs ??
              1000 * journal.attempts.length,
            30_000,
          ),
        );
        continue;
      }
      const receipt: ControlledReceipt = {
        ...expectedFor(job),
        evaluatedAt: new Date().toISOString(),
        attempts: journal.attempts.length,
        result,
      };
      await save(path, { receipt, receiptHash: controlledHash(receipt) }, true);
      Object.assign(attempt, {
        endedAt: receipt.evaluatedAt,
        outcome: "success",
      });
      await saveJournal();
      receipts.push(receipt);
      dependencies.progress?.({
        phase,
        completed: receipts.length,
        total: jobs.length,
        knownCost: receipts.reduce(
          (sum, item) => sum + (receiptCost(item) ?? 0),
          0,
        ),
      });
      break;
    }
  }
  const summary = {
    protocolHash,
    phaseProtocolHash: phaseHash(phase),
    completedAt: new Date().toISOString(),
    ...summarizeControlled(
      cases,
      review,
      partition,
      receipts,
      phase,
      phase === "validation" ? validationProtocol?.thresholds : undefined,
    ),
  };
  const summaryPath = join(directory, `summary-${phase}.json`);
  const oldSummary = await optional(summaryPath);
  if (oldSummary) {
    const { completedAt: _oldAt, ...oldContent } = JSON.parse(oldSummary);
    const { completedAt: _newAt, ...newContent } = summary;
    if (controlledHash(oldContent) !== controlledHash(newContent))
      invalid("Saved summary differs from validated receipts.");
    return JSON.parse(oldSummary) as typeof summary;
  }
  await save(summaryPath, summary, true);
  return summary;
}
async function main() {
  const { values } = parseArgs({
    options: { input: { type: "string" }, phase: { type: "string" } },
  });
  if (!values.input) invalid("Supply --input experiment directory.");
  const phase = phaseSchema.parse(values.phase);
  loadEnvConfig(process.cwd());
  const summary = await runControlled(
    { input: values.input, phase },
    { progress: (progress) => console.log(JSON.stringify(progress)) },
  );
  console.log(
    JSON.stringify({
      status: summary.status,
      phase,
      evaluations: summary.evaluations,
      uniqueCases: summary.uniqueCases,
      knownCost: summary.cost.known,
    }),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch(() => {
    console.error(
      "Controlled evaluation stopped. Inspect the frozen artifacts and sanitized attempt metadata; no labels or provider response text are logged.",
    );
    process.exitCode = 1;
  });
}
