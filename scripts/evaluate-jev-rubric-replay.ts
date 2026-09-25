import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
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
  CONSOLIDATION_QUESTIONS_V2,
  type ConsolidationQuestions,
} from "../lib/maintenance/consolidation-rubric";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import {
  type ConsolidationEvaluation,
  type ConsolidationEvaluationInput,
  evaluateConsolidationProposal,
  JEV_BASELINE_QUESTIONS,
  JEV_CONSOLIDATION_THRESHOLDS,
  JEV_MODEL,
} from "../lib/maintenance/jev";

// This replay has no generator, database client, document writer or production gate.
const criteria = Object.keys(JEV_CONSOLIDATION_THRESHOLDS) as Array<
  keyof typeof JEV_CONSOLIDATION_THRESHOLDS
>;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const labelSchema = z.strictObject({
  verdict: z.enum(["pass", "fail", "uncertain"]),
  rationale: z.string().trim().min(1).max(10_000),
});
const reviewSchema = z.strictObject({
  reviewer: z.literal("blind-subagent"),
  rubricHash: digestSchema,
  candidates: z.array(
    z.strictObject({
      caseId: z.string().min(1),
      inputHash: digestSchema,
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
        inputHash: digestSchema,
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
type Review = z.infer<typeof reviewSchema>;
type Case = z.infer<typeof casesSchema>["cases"][number];
type Verdict = "pass" | "fail" | "uncertain";
type Variant = "baseline" | "revised";
type Job = {
  sequence: number;
  caseIndex: number;
  repeat: number;
  variant: Variant;
};
type Receipt = Job & {
  caseId: string;
  inputHash: string;
  reviewHash: string;
  rubricHash: string;
  protocolHash: string;
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
type Dependencies = {
  evaluate?: (
    input: ConsolidationEvaluationInput,
    options: { questions: ConsolidationQuestions },
  ) => Promise<ConsolidationEvaluation>;
  sleep?: (milliseconds: number) => Promise<void>;
  progress?: (progress: {
    completed: number;
    total: number;
    knownCost: number;
  }) => void;
};

function hashText(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
function hash(value: unknown) {
  return hashText(JSON.stringify(value));
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
async function save(path: string, value: unknown) {
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(`${path}.tmp`, 0o600);
  await rename(`${path}.tmp`, path);
}
function invalid(message: string): never {
  throw new Error(message);
}
function questions(variant: Variant): ConsolidationQuestions {
  return variant === "baseline"
    ? JEV_BASELINE_QUESTIONS
    : CONSOLIDATION_QUESTIONS_V2;
}

export function replayJobs(caseCount: number): Job[] {
  const jobs: Job[] = [];
  for (let repeat = 1; repeat <= 3; repeat++) {
    for (let caseIndex = 0; caseIndex < caseCount; caseIndex++) {
      const order: Variant[] =
        (caseIndex + repeat) % 2 === 0
          ? ["baseline", "revised"]
          : ["revised", "baseline"];
      for (const variant of order)
        jobs.push({ sequence: jobs.length + 1, caseIndex, repeat, variant });
    }
  }
  return jobs;
}

function validateReview(review: Review, cases: Case[], rubricHash: string) {
  if (review.rubricHash !== rubricHash)
    invalid("Blind review rubric hash differs.");
  const remaining = new Map(cases.map((item) => [item.caseId, item]));
  if (
    remaining.size !== cases.length ||
    review.candidates.length !== cases.length
  )
    invalid("Every case must have exactly one blind review.");
  for (const candidate of review.candidates) {
    const item = remaining.get(candidate.caseId);
    if (!item || item.inputHash !== candidate.inputHash)
      invalid("Blind review case or input hash differs.");
    remaining.delete(candidate.caseId);
  }
  if (remaining.size) invalid("Blind review is incomplete.");
}

function validateResult(result: PositiveConsolidationEvaluation) {
  if (
    !result ||
    result.model !== JEV_MODEL ||
    !result.answers ||
    Object.keys(result.answers).length !== criteria.length ||
    criteria.some(
      (key) =>
        !Number.isFinite(result.answers[key]) ||
        result.answers[key] < 0 ||
        result.answers[key] > 1,
    )
  )
    invalid("Invalid evaluation scores or model.");
  if (
    result.allowed !==
    criteria.every(
      (key) => result.answers[key] >= JEV_CONSOLIDATION_THRESHOLDS[key],
    )
  )
    invalid("Evaluation decision differs from the frozen thresholds.");
  if (
    !result.usage ||
    Object.values(result.usage.gateway ?? {}).some(
      (value) => !Number.isFinite(value) || value < 0,
    )
  )
    invalid("Invalid evaluation usage.");
}
function cost(receipt: Receipt) {
  const gateway = receipt.result.usage.gateway;
  return gateway?.cost ?? gateway?.totalCost ?? null;
}
function reference(review: Review["candidates"][number]): Verdict {
  const labels = criteria.map((key) => review.criteria[key].verdict);
  return labels.includes("fail")
    ? "fail"
    : labels.includes("uncertain")
      ? "uncertain"
      : "pass";
}
function confusion(items: Array<{ reference: Verdict; allowed: boolean }>) {
  const counts = {
    pass: { accepted: 0, rejected: 0 },
    fail: { accepted: 0, rejected: 0 },
    uncertain: { accepted: 0, rejected: 0 },
  };
  for (const item of items)
    counts[item.reference][item.allowed ? "accepted" : "rejected"]++;
  return counts;
}
function distribution(scores: number[]) {
  const sorted = [...scores].sort((a, b) => a - b);
  return { min: sorted[0], median: sorted[1], max: sorted[2] };
}

export function summarizeReplay(
  cases: Case[],
  review: Review,
  receipts: Receipt[],
) {
  const reviews = new Map(review.candidates.map((item) => [item.caseId, item]));
  const referenceFor = (id: string) => {
    const item = reviews.get(id);
    if (!item) return invalid("Missing reference during analysis.");
    return item;
  };
  const variants = Object.fromEntries(
    (["baseline", "revised"] as const).map((variant) => {
      const selected = receipts.filter((item) => item.variant === variant);
      const byCase = cases.map((item) => {
        const runs = selected
          .filter((receipt) => receipt.caseId === item.caseId)
          .sort((a, b) => a.repeat - b.repeat);
        if (runs.length !== 3)
          invalid(
            "Analysis requires three completed repeats for every case and variant.",
          );
        const passCount = runs.filter((run) => run.result.allowed).length;
        return {
          caseId: item.caseId,
          reference: reference(referenceFor(item.caseId)),
          passCount,
          decisions: runs.map((run) => run.result.allowed),
          flips: passCount > 0 && passCount < 3,
          criteria: Object.fromEntries(
            criteria.map((key) => {
              const values = runs.map((run) => run.result.answers[key]);
              const criterionPassCount = values.filter(
                (score) => score >= JEV_CONSOLIDATION_THRESHOLDS[key],
              ).length;
              return [
                key,
                {
                  reference: referenceFor(item.caseId).criteria[key].verdict,
                  scores: values,
                  ...distribution(values),
                  passCount: criterionPassCount,
                  flips: criterionPassCount > 0 && criterionPassCount < 3,
                },
              ];
            }),
          ),
        };
      });
      const perRun = [1, 2, 3].map((repeat) => {
        const runs = selected.filter((item) => item.repeat === repeat);
        return {
          repeat,
          cases: runs.length,
          overall: confusion(
            runs.map((run) => ({
              reference: reference(referenceFor(run.caseId)),
              allowed: run.result.allowed,
            })),
          ),
          criteria: Object.fromEntries(
            criteria.map((key) => [
              key,
              confusion(
                runs.map((run) => ({
                  reference: referenceFor(run.caseId).criteria[key].verdict,
                  allowed:
                    run.result.answers[key] >=
                    JEV_CONSOLIDATION_THRESHOLDS[key],
                })),
              ),
            ]),
          ),
        };
      });
      const stabilityPolicies = Object.fromEntries(
        (["all3", "any", "majority"] as const).map((policy) => {
          const accepts = (passCount: number) =>
            policy === "all3"
              ? passCount === 3
              : policy === "any"
                ? passCount > 0
                : passCount >= 2;
          return [
            policy,
            {
              overall: confusion(
                byCase.map((item) => ({
                  reference: item.reference,
                  allowed: accepts(item.passCount),
                })),
              ),
              criteria: Object.fromEntries(
                criteria.map((key) => [
                  key,
                  confusion(
                    byCase.map((item) => ({
                      reference: item.criteria[key].reference,
                      allowed: accepts(item.criteria[key].passCount),
                    })),
                  ),
                ]),
              ),
            },
          ];
        }),
      );
      return [
        variant,
        {
          uniqueCases: cases.length,
          evaluations: selected.length,
          perRun,
          descriptiveStabilityPolicies: stabilityPolicies,
          casesWithDecisionFlips: byCase.filter((item) => item.flips).length,
          criterionFlips: Object.fromEntries(
            criteria.map((key) => [
              key,
              byCase.filter((item) => item.criteria[key].flips).length,
            ]),
          ),
          byCase,
          cost: {
            known: selected.reduce((sum, item) => sum + (cost(item) ?? 0), 0),
            missingReceipts: selected.filter((item) => cost(item) === null)
              .length,
          },
          attempts: selected.reduce((sum, item) => sum + item.attempts, 0),
        },
      ];
    }),
  );
  return {
    status: "completed" as const,
    uniqueCases: cases.length,
    evaluations: receipts.length,
    repetitions: 3,
    thresholds: JEV_CONSOLIDATION_THRESHOLDS,
    reference:
      "Frozen blind-subagent judgments; a comparative reference, not ground truth.",
    caution:
      "Repeated evaluations are stability measurements of the same cases, not independent examples. All3/any/majority are descriptive only and do not replace the fixed per-request policy.",
    variants,
    cost: {
      known: receipts.reduce((sum, item) => sum + (cost(item) ?? 0), 0),
      missingReceipts: receipts.filter((item) => cost(item) === null).length,
      note: "Only successful receipts provide billing metadata; failed or interrupted attempts may incur unreported charges.",
    },
  };
}

export async function runRubricReplay(
  options: { input: string },
  dependencies: Dependencies = {},
) {
  const directory = resolve(options.input);
  const artifactNames = [
    "cases.json",
    "subagent-review.json",
    "evaluation-spec.json",
    "rubric.json",
  ];
  const texts = await Promise.all(
    artifactNames.map((name) => readFile(join(directory, name), "utf8")),
  );
  let cases: Case[];
  let review: Review;
  try {
    cases = casesSchema.parse(JSON.parse(texts[0])).cases;
    review = reviewSchema.parse(JSON.parse(texts[1]));
    const spec = z
      .object({
        repetitions: z.literal(3),
        cases: z.number().int().positive().optional(),
        thresholds: z.record(z.string(), z.number()).optional(),
      })
      .parse(JSON.parse(texts[2]));
    if (spec.cases !== undefined && spec.cases !== cases.length)
      invalid("Specification case count differs.");
    if (
      spec.thresholds !== undefined &&
      (Object.keys(spec.thresholds).length !== criteria.length ||
        criteria.some(
          (key) => spec.thresholds?.[key] !== JEV_CONSOLIDATION_THRESHOLDS[key],
        ))
    )
      invalid("Specification thresholds differ.");
  } catch {
    return invalid("Invalid cases, review or evaluation specification.");
  }
  for (const item of cases)
    if (hash(item.input) !== item.inputHash)
      invalid("Case input hash differs.");
  const rubricHash = hashText(texts[3]);
  if (hash(JSON.parse(texts[3])) !== hash(CONSOLIDATION_QUESTIONS_V2))
    invalid("The review rubric differs from the revised Jev questions.");
  validateReview(review, cases, rubricHash);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const codeNames = [
    "scripts/evaluate-jev-rubric-replay.ts",
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
        hashText(await readFile(join(root, name))),
      ]),
    ),
  );
  const frozen = {
    version: 1,
    artifactHashes: Object.fromEntries(
      artifactNames.map((name, index) => [name, hashText(texts[index])]),
    ),
    codeHashes,
    questions: {
      baseline: JEV_BASELINE_QUESTIONS,
      revised: CONSOLIDATION_QUESTIONS_V2,
    },
    thresholds: JEV_CONSOLIDATION_THRESHOLDS,
    model: JEV_MODEL,
    repetitions: 3,
    order:
      "repeat-major; case-index plus repeat parity alternates the first variant",
  };
  const protocolPath = join(directory, "protocol.json");
  const oldProtocol = await optional(protocolPath);
  const protocol = oldProtocol
    ? JSON.parse(oldProtocol)
    : { frozenAt: new Date().toISOString(), ...frozen };
  const { frozenAt, ...existingFrozen } = protocol;
  if (
    typeof frozenAt !== "string" ||
    !Number.isFinite(Date.parse(frozenAt)) ||
    hash(existingFrozen) !== hash(frozen)
  )
    invalid("Frozen experiment inputs, code or questions changed.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await Promise.all(
    artifactNames.map((name) => chmod(join(directory, name), 0o600)),
  );
  if (!oldProtocol) await save(protocolPath, protocol);
  const protocolHash = hash(protocol);
  const receiptDirectory = join(directory, "receipts");
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  await chmod(receiptDirectory, 0o700);
  const jobs = replayJobs(cases.length);
  const receipts: Receipt[] = [];
  const reviewHash = hashText(texts[1]);
  const receiptName = (job: Job) =>
    `${String(job.sequence).padStart(4, "0")}.json`;
  const allowedFiles = new Set(
    jobs.flatMap((job) => [receiptName(job), `${receiptName(job)}.attempts`]),
  );
  for (const name of await readdir(receiptDirectory))
    if (!allowedFiles.has(name))
      invalid("Unexpected receipt artifact; inspect before resuming.");
  const expectedFor = (job: Job) => ({
    ...job,
    caseId: cases[job.caseIndex].caseId,
    inputHash: cases[job.caseIndex].inputHash,
    reviewHash,
    rubricHash,
    protocolHash,
    questionsHash: hash(questions(job.variant)),
  });
  // Validate every saved receipt before the first new provider request.
  for (const job of jobs) {
    const text = await optional(join(receiptDirectory, receiptName(job)));
    if (!text) continue;
    const envelope = JSON.parse(text);
    if (envelope.receiptHash !== hash(envelope.receipt))
      invalid("Saved receipt hash differs.");
    const receipt = envelope.receipt as Receipt;
    const { evaluatedAt, attempts, result, ...savedExpected } = receipt;
    if (
      hash(savedExpected) !== hash(expectedFor(job)) ||
      typeof evaluatedAt !== "string" ||
      !Number.isFinite(Date.parse(evaluatedAt)) ||
      Date.parse(evaluatedAt) < Date.parse(frozenAt) ||
      !Number.isInteger(attempts) ||
      attempts < 1 ||
      attempts > 3
    )
      invalid("Saved receipt refers to different frozen inputs.");
    validateResult(result);
    const journalText = await optional(
      join(receiptDirectory, `${receiptName(job)}.attempts`),
    );
    const journal = journalText ? JSON.parse(journalText) : null;
    if (
      !journal ||
      journal.protocolHash !== protocolHash ||
      journal.attempts.length !== attempts
    )
      invalid("Saved attempt journal differs from receipt.");
    // A receipt may have persisted immediately before a process interruption.
    const lastAttempt = journal.attempts.at(-1);
    if (!["started", "success"].includes(lastAttempt?.outcome))
      invalid("Saved attempt outcome differs from receipt.");
    if (
      typeof lastAttempt.startedAt !== "string" ||
      !Number.isFinite(Date.parse(lastAttempt.startedAt)) ||
      Date.parse(lastAttempt.startedAt) < Date.parse(frozenAt) ||
      Date.parse(lastAttempt.startedAt) > Date.parse(evaluatedAt)
    )
      invalid("Saved request chronology differs from the frozen protocol.");
    receipts.push(receipt);
  }
  const evaluate = dependencies.evaluate ?? evaluateConsolidationProposal;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((done) => setTimeout(done, milliseconds)));
  for (const job of jobs) {
    if (receipts.some((item) => item.sequence === job.sequence)) continue;
    const path = join(receiptDirectory, receiptName(job));
    const journalPath = `${path}.attempts`;
    const journalText = await optional(journalPath);
    const journal: { protocolHash: string; attempts: Attempt[] } = journalText
      ? JSON.parse(journalText)
      : { protocolHash, attempts: [] };
    if (
      journal.protocolHash !== protocolHash ||
      !Array.isArray(journal.attempts)
    )
      invalid("Saved attempt journal refers to different frozen inputs.");
    const last = journal.attempts.at(-1);
    if (last && (last.outcome !== "error" || !last.retryable))
      invalid(
        "An interrupted or non-retryable request has no saved result; manual inspection required.",
      );
    if (journal.attempts.length >= 3)
      invalid("The bounded request attempt limit was reached.");
    for (;;) {
      const attempt: Attempt = {
        startedAt: new Date().toISOString(),
        outcome: "started",
      };
      journal.attempts.push(attempt);
      await save(journalPath, journal);
      let result: PositiveConsolidationEvaluation;
      try {
        result = applyPositiveConsolidationPolicy(
          await evaluate(cases[job.caseIndex].input, {
            questions: questions(job.variant),
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
        await save(journalPath, journal);
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
      const receipt: Receipt = {
        ...expectedFor(job),
        evaluatedAt: new Date().toISOString(),
        attempts: journal.attempts.length,
        result,
      };
      await save(path, { receipt, receiptHash: hash(receipt) });
      Object.assign(attempt, {
        endedAt: receipt.evaluatedAt,
        outcome: "success",
      });
      await save(journalPath, journal);
      receipts.push(receipt);
      dependencies.progress?.({
        completed: receipts.length,
        total: jobs.length,
        knownCost: receipts.reduce((sum, item) => sum + (cost(item) ?? 0), 0),
      });
      break;
    }
  }
  const summary = {
    protocolHash,
    completedAt: new Date().toISOString(),
    ...summarizeReplay(cases, review, receipts),
  };
  const oldSummary = await optional(join(directory, "summary.json"));
  if (oldSummary) {
    const { completedAt: _oldAt, ...oldContent } = JSON.parse(oldSummary);
    const { completedAt: _newAt, ...newContent } = summary;
    if (hash(oldContent) !== hash(newContent))
      invalid("Saved summary differs from validated receipts.");
    return JSON.parse(oldSummary) as typeof summary;
  }
  await save(join(directory, "summary.json"), summary);
  return summary;
}

async function main() {
  const { values } = parseArgs({ options: { input: { type: "string" } } });
  if (!values.input) invalid("Supply --input experiment directory.");
  loadEnvConfig(process.cwd());
  const summary = await runRubricReplay(
    { input: values.input },
    {
      progress: (progress) => console.log(JSON.stringify(progress)),
    },
  );
  console.log(
    JSON.stringify({
      status: summary.status,
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
      "Replay stopped. Inspect the frozen protocol and sanitized attempt metadata; no provider response text is logged.",
    );
    process.exitCode = 1;
  });
}
