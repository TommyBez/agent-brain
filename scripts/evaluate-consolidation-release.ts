import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadEnvConfig } from "@next/env";
import {
  CANDIDATE_BANDS,
  CANDIDATE_POLICY_HASH,
  CANDIDATE_POLICY_VERSION,
  type CandidateOutcome,
  CandidateRecordedError,
  candidateError,
  evaluateCandidate,
} from "../lib/maintenance/consolidation-candidate";
import { DEFECT_CONSOLIDATION_QUESTIONS } from "../lib/maintenance/consolidation-defect-questions";
import { consolidationProposalSchema } from "../lib/maintenance/consolidation-proposals";
import {
  CONSOLIDATION_CRITERIA,
  CONSOLIDATION_QUESTIONS_V2,
  type ConsolidationCriterion as Criterion,
} from "../lib/maintenance/consolidation-rubric";
import {
  type ConsolidationEvaluation,
  type ConsolidationEvaluationInput,
  evaluateConsolidationProposal,
  JEV_MODEL,
} from "../lib/maintenance/jev";
import {
  JEV_RECOVERY,
  recoverJevTransport,
} from "../lib/maintenance/jev-recovery";
import { JEV_STATE_ENCODING } from "../lib/maintenance/jev-state";
import {
  KIMI_EVALUATOR_SETTINGS,
  type KimiEvaluation,
} from "../lib/maintenance/kimi-evaluator";
import {
  KIMI_PRESERVATION_INSTRUCTIONS,
  KIMI_SOURCE_AUDIT_CONTRACT,
} from "../lib/maintenance/kimi-source-audit";
import { KIMI_SOURCE_CHALLENGE_CONTRACT } from "../lib/maintenance/kimi-source-challenge";
import {
  evaluateWithKimiSourceContract,
  KIMI_SOURCE_CONTRACT,
  KIMI_SOURCE_CONTRACT_CLARIFICATION,
} from "../lib/maintenance/kimi-source-contract";
import { KIMI_UTILITY_INSTRUCTIONS } from "../lib/maintenance/kimi-utility";
import { withKimiFailureDiagnostic } from "./consolidation-evaluation-diagnostics";
import { buildFilterContract } from "./prepare-filter-contract";

const SOURCE = "supported_by_evidence";
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DATASET = "artifacts/consolidation/jev-kimi-fixed-v1";
const FIXTURE = "scripts/fixtures/consolidation-release-v1.json";
const SOURCE_FIXTURE = "scripts/fixtures/kimi-source-contract-v1.json";
const CRITERIA = CONSOLIDATION_CRITERIA;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
type Input = ConsolidationEvaluationInput;
type Judgment = {
  verdict?: "pass" | "fail";
  acceptableVerdicts?: ("fail" | "uncertain")[];
  rationale: string;
};
type InputCase = { caseId: string; inputHash: string; input: Input };
type Reference = {
  caseId: string;
  inputHash: string;
  originId: string;
  cohort: "existing" | "new" | "heldout" | "regression" | "source-only";
  category: string;
  label: string;
  expectedDecision?: "accept" | "reject" | "do_not_apply";
  expectedCriteria: Partial<Record<Criterion, Judgment>>;
  rationale: string;
  proof?: unknown;
};
type Evaluation = Awaited<ReturnType<typeof evaluateCandidate>>;
type GlobalRow = Reference & Evaluation & { repetition: number; jobId: string };
type SourceRow = Reference & {
  repetition: number;
  jobId: string;
  outcome: CandidateOutcome<KimiEvaluation>;
  verdict: string;
};
type Source = {
  pageId: string;
  version: number;
  title: string;
  markdown: string;
};
type ReleaseFixture = {
  scenarios: {
    scenarioId: string;
    title: string;
    target: Source & { type: string; summary: string };
    sources: Source[];
    rules: { evidence: { pageId: string; quote: string }[] }[];
    candidates: {
      designId: string;
      label: string;
      category: "valid" | "invalid" | "ambiguous";
      afterMarkdown: string;
      expectedDecision: "accept" | "reject" | "do_not_apply";
      expectedCriteria: Reference["expectedCriteria"];
      rationale: string;
      proof: {
        location: "before" | "after" | "source";
        pageId?: string;
        quote: string;
      }[];
    }[];
  }[];
};

async function optional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function immutable(path: string, value: unknown) {
  const bytes = json(value),
    old = await optional(path);
  if (old !== undefined)
    assert.equal(old, bytes, `Frozen artifact differs: ${path}`);
  else await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
}
function allStrings(value: unknown): string[] {
  return typeof value === "string"
    ? [value]
    : value && typeof value === "object"
      ? Object.values(value).flatMap(allStrings)
      : [];
}
function allowed(judgment: Judgment | undefined): string[] {
  assert.ok(judgment, "Missing explicit criterion reference");
  if (judgment.acceptableVerdicts) {
    assert.deepEqual(judgment.acceptableVerdicts, ["fail", "uncertain"]);
    return judgment.acceptableVerdicts;
  }
  assert.ok(judgment.verdict === "pass" || judgment.verdict === "fail");
  return [judgment.verdict];
}

/** Builds the same four-field model input as the approved benchmark, with all reference data separate. */
export function buildReleaseCases(
  fixture: ReleaseFixture,
  expectedCounts = { valid: 4, invalid: 4, ambiguous: 4 },
) {
  const inputs: InputCase[] = [],
    references: Reference[] = [],
    counts = { valid: 0, invalid: 0, ambiguous: 0 };
  const ids = new Set<string>();
  for (const scenario of fixture.scenarios) {
    const target = scenario.target;
    const sources = [
      {
        pageId: target.pageId,
        version: target.version,
        title: target.title,
        markdown: target.markdown,
      },
      ...scenario.sources,
    ];
    const pages = new Map(sources.map((page) => [page.pageId, page]));
    assert.equal(pages.size, sources.length);
    for (const rule of scenario.rules)
      for (const proof of rule.evidence)
        assert.ok(
          proof.quote &&
            pages.get(proof.pageId)?.markdown.includes(proof.quote),
        );
    for (const candidate of scenario.candidates) {
      assert.ok(!ids.has(candidate.designId));
      ids.add(candidate.designId);
      counts[candidate.category]++;
      assert.notEqual(candidate.afterMarkdown, target.markdown);
      assert.ok(
        candidate.expectedDecision === "accept"
          ? CRITERIA.every(
              (key) => candidate.expectedCriteria[key]?.verdict === "pass",
            )
          : Object.values(candidate.expectedCriteria).some((j) =>
              allowed(j).every((v) => v === "fail" || v === "uncertain"),
            ),
      );
      for (const proof of candidate.proof) {
        const text =
          proof.location === "source"
            ? pages.get(proof.pageId ?? "")?.markdown
            : proof.location === "before"
              ? target.markdown
              : candidate.afterMarkdown;
        assert.ok(
          proof.quote && text?.includes(proof.quote),
          `Invalid proof ${candidate.designId}`,
        );
      }
      for (const match of candidate.afterMarkdown.matchAll(/\]\(([^\s)]+)\)/g))
        assert.ok(
          pages.has(match[1]),
          `Unresolved fixture link ${candidate.designId}`,
        );
      const before = {
        title: target.title,
        type: target.type,
        summary: target.summary,
        markdown: target.markdown,
      };
      const citations = sources.map((source) => ({
        pageId: source.pageId,
        version: source.version,
        quote: source.markdown,
      }));
      const operation = consolidationProposalSchema.parse({
        operation: "consolidate_passage",
        pageId: target.pageId,
        expectedVersion: target.version,
        reason: "Consolidamento dei contenuti della pagina.",
        before: target.markdown,
        after: candidate.afterMarkdown,
        evidence: citations,
      });
      const input = {
        before,
        after: { ...before, markdown: candidate.afterMarkdown },
        evidence: { sources, citations },
        operation,
      };
      const inputHash = hash(JSON.stringify(input));
      inputs.push({ caseId: candidate.designId, inputHash, input });
      references.push({
        caseId: candidate.designId,
        inputHash,
        originId: candidate.designId,
        cohort: "new",
        category: candidate.category,
        label: candidate.label,
        expectedDecision: candidate.expectedDecision,
        expectedCriteria: candidate.expectedCriteria,
        rationale: candidate.rationale,
        proof: candidate.proof,
      });
    }
  }
  assert.deepEqual(counts, expectedCounts);
  assert.equal(new Set(inputs.map((row) => row.inputHash)).size, 12);
  return { inputs, references };
}

export function summarizeReleaseRows(rows: GlobalRow[]) {
  const count = (fn: (row: GlobalRow) => boolean) => rows.filter(fn).length;
  const correct = (row: GlobalRow) =>
    row.expectedDecision === "do_not_apply"
      ? ["reject", "uncertain"].includes(row.finalDecision)
      : row.expectedDecision === row.finalDecision;
  const matrix = Object.fromEntries(
    ["accept", "reject", "do_not_apply"].map((expected) => [
      expected,
      Object.fromEntries(
        ["accept", "reject", "uncertain", "error"].map((actual) => [
          actual,
          count(
            (r) =>
              r.expectedDecision === expected && r.finalDecision === actual,
          ),
        ]),
      ),
    ]),
  );
  const byCriterion = Object.fromEntries(
    CRITERIA.map((key) => {
      const scored = rows.filter((r) => r.expectedCriteria[key]);
      const stage = (method: "jev" | "kimi" | "cascade") => {
        const observations = scored.map((row) => ({
          row,
          actual:
            method === "jev"
              ? row.jevCriteria[key]
              : method === "cascade"
                ? row.finalCriteria[key]
                : row.selected.includes(key)
                  ? row.kimi?.status === "success"
                    ? (row.kimi.result.judgments[key]?.verdict ?? "error")
                    : "error"
                  : "not_evaluated",
        }));
        const n = (fn: (o: (typeof observations)[number]) => boolean) =>
          observations.filter(fn).length;
        return {
          correct: n((o) =>
            allowed(o.row.expectedCriteria[key]).includes(o.actual),
          ),
          wrongDefinitive: n(
            (o) =>
              ["pass", "fail"].includes(o.actual) &&
              !allowed(o.row.expectedCriteria[key]).includes(o.actual),
          ),
          falsePass: n(
            (o) =>
              o.actual === "pass" &&
              !allowed(o.row.expectedCriteria[key]).includes("pass"),
          ),
          falseFail: n(
            (o) =>
              o.actual === "fail" &&
              !allowed(o.row.expectedCriteria[key]).includes("fail"),
          ),
          deferred: n((o) => o.actual === "defer"),
          uncertain: n((o) => o.actual === "uncertain"),
          errors: n((o) => o.actual === "error"),
          notEvaluated: n((o) => o.actual === "not_evaluated"),
        };
      };
      return [
        key,
        {
          labeled: scored.length,
          notScored: rows.length - scored.length,
          jev: stage("jev"),
          kimi: stage("kimi"),
          cascade: stage("cascade"),
        },
      ];
    }),
  );
  return {
    total: rows.length,
    correct: count(correct),
    falseAccept: count(
      (r) => r.expectedDecision !== "accept" && r.finalDecision === "accept",
    ),
    falseReject: count(
      (r) => r.expectedDecision === "accept" && r.finalDecision === "reject",
    ),
    uncertain: count((r) => r.finalDecision === "uncertain"),
    errors: count((r) => r.finalDecision === "error"),
    kimiCalls: count((r) => r.selected.length > 0),
    routes: Object.fromEntries(
      ["accept", "reject", "defer", "error"].map((route) => [
        route,
        count((r) => r.route === route),
      ]),
    ),
    matrix,
    byCriterion,
  };
}

export type ReceiptIdentity = {
  protocolHash: string;
  jobId: string;
  kind: "jev" | "kimi" | "source-kimi";
  inputHash: string;
  selected: Criterion[];
  attempt?: number;
};
type Receipt<T> = {
  identity: ReceiptIdentity;
  startedAt: string;
  endedAt: string;
  outcome: CandidateOutcome<T>;
  outcomeHash: string;
};
/** A started call without an outcome is never retried; error receipts retain safe diagnostics on replay. */
export async function recordedCall<T>(
  path: string,
  identity: ReceiptIdentity,
  mode: "run" | "verify",
  call: () => Promise<T>,
  beforeStart: () => void = () => {},
): Promise<Receipt<T>> {
  const saved = await optional(path);
  if (saved) {
    const receipt = JSON.parse(saved) as Receipt<T>;
    assert.deepEqual(receipt.identity, identity);
    assert.equal(receipt.outcomeHash, hash(json(receipt.outcome)));
    assert.deepEqual(
      JSON.parse((await optional(`${path}.started`)) ?? "null"),
      { identity, startedAt: receipt.startedAt },
    );
    return receipt;
  }
  assert.equal(
    mode,
    "run",
    `Missing receipt ${identity.jobId}/${identity.kind}`,
  );
  assert.equal(
    await optional(`${path}.started`),
    undefined,
    `Unknown provider outcome; do not retry ${identity.jobId}/${identity.kind}`,
  );
  beforeStart();
  const startedAt = new Date().toISOString();
  await immutable(`${path}.started`, { identity, startedAt });
  let outcome: CandidateOutcome<T>;
  try {
    outcome = { status: "success", result: await call() };
  } catch (error) {
    outcome = { status: "error", error: candidateError(error) };
  }
  const receipt = {
    identity,
    startedAt,
    endedAt: new Date().toISOString(),
    outcome,
    outcomeHash: hash(json(outcome)),
  };
  await immutable(path, receipt);
  return receipt;
}
function resultOrThrow<T>(outcome: CandidateOutcome<T>): T {
  if (outcome.status === "success") return outcome.result;
  throw new CandidateRecordedError(outcome.error);
}

/** Replay the original elapsed request times, including when a late 503 exhausted the budget. */
export async function recoverRecordedJevTransport(
  request: (
    attempt: number,
    timeoutMs: number,
  ) => Promise<Receipt<ConsolidationEvaluation>>,
  mode: "run" | "verify",
) {
  let elapsed = 0;
  let firstStartedAt: number | null = null;
  return recoverJevTransport(
    async (attempt, timeoutMs) => {
      const receipt = await request(attempt, timeoutMs);
      const start = Date.parse(receipt.startedAt),
        end = Date.parse(receipt.endedAt);
      assert.ok(Number.isFinite(start) && Number.isFinite(end) && end >= start);
      firstStartedAt ??= start;
      elapsed = Math.max(elapsed, end - firstStartedAt);
      return resultOrThrow(receipt.outcome);
    },
    {
      now: () => elapsed,
      wait: async (ms) => {
        if (mode === "run")
          await new Promise((resolve) => setTimeout(resolve, ms));
        elapsed += ms;
      },
    },
  );
}
function receiptUsage(
  receipt: Receipt<ConsolidationEvaluation | KimiEvaluation>,
) {
  const usage =
    receipt.outcome.status === "success"
      ? receipt.outcome.result.usage
      : receipt.outcome.error.diagnostic?.usage;
  const cost =
    usage && "costUsd" in usage
      ? usage.costUsd
      : usage && "gateway" in usage
        ? usage.gateway?.cost
        : null;
  const reviews =
    receipt.outcome.status === "success"
      ? "reviewReceipts" in receipt.outcome.result
        ? receipt.outcome.result.reviewReceipts
        : undefined
      : receipt.outcome.error.diagnostic?.reviewReceipts;
  const physicalCalls =
    usage && "physicalCalls" in usage ? (usage.physicalCalls ?? 1) : 1;
  return {
    physicalCalls,
    missingCosts:
      usage && "unknownCostCalls" in usage
        ? (usage.unknownCostCalls ?? (cost == null ? 1 : 0))
        : cost == null
          ? 1
          : 0,
    missingInputTokens:
      reviews?.filter((r) => r.usage.inputTokens == null).length ??
      (usage?.inputTokens == null ? 1 : 0),
    missingOutputTokens:
      reviews?.filter((r) => r.usage.outputTokens == null).length ??
      (usage?.outputTokens == null ? 1 : 0),
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    costUsd:
      typeof cost === "number" && Number.isFinite(cost) && cost >= 0
        ? cost
        : null,
  };
}
function accounting(
  receipts: Receipt<ConsolidationEvaluation | KimiEvaluation>[],
) {
  const values = receipts.map(receiptUsage);
  return {
    calls: values.reduce((sum, v) => sum + v.physicalCalls, 0),
    errors: receipts.filter((r) => r.outcome.status === "error").length,
    knownCostUsd:
      Number(
        values.reduce(
          (sum, v) => sum + BigInt(Math.round((v.costUsd ?? 0) * 1e12)),
          BigInt(0),
        ),
      ) / 1e12,
    missingCosts: values.reduce((sum, v) => sum + v.missingCosts, 0),
    knownInputTokens: values.reduce((sum, v) => sum + (v.inputTokens ?? 0), 0),
    missingInputTokens: values.reduce(
      (sum, v) => sum + v.missingInputTokens,
      0,
    ),
    knownOutputTokens: values.reduce(
      (sum, v) => sum + (v.outputTokens ?? 0),
      0,
    ),
    missingOutputTokens: values.reduce(
      (sum, v) => sum + v.missingOutputTokens,
      0,
    ),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      output: {
        type: "string",
        default: "artifacts/consolidation/release-v1/filter-validation",
      },
      review: {
        type: "string",
        default:
          "artifacts/consolidation/release-v1/validation-prep/independent-fixture-review.json",
      },
      mode: { type: "string", default: "prepare" },
      regression: { type: "string" },
      "regression-review": { type: "string" },
      heldout: { type: "string" },
      "heldout-review": { type: "string" },
    },
  });
  assert.ok(["prepare", "run", "verify"].includes(values.mode));
  const mode = values.mode as "prepare" | "run" | "verify",
    output = resolve(values.output);
  const inputHashes: Record<string, string> = {};
  async function tracked(path: string) {
    const text = await readFile(join(ROOT, path), "utf8");
    inputHashes[path] = hash(text);
    return text;
  }
  const fixtureText = await tracked(FIXTURE),
    fixture = JSON.parse(fixtureText) as ReleaseFixture;
  const reviewText = await readFile(resolve(values.review), "utf8"),
    review = JSON.parse(reviewText);
  assert.equal(
    review.approved,
    true,
    "Independent fixture approval required before freeze",
  );
  assert.equal(
    review.fixtureHash,
    hash(fixtureText),
    "Review refers to another fixture",
  );
  const built = buildReleaseCases(fixture);
  const extensions: Partial<
    Record<"heldout" | "regression", ReturnType<typeof buildReleaseCases>>
  > = {};
  const extensionReviewHashes: Partial<
    Record<"heldout" | "regression", string>
  > = {};
  for (const cohort of ["regression", "heldout"] as const) {
    const path = values[cohort];
    if (!path) continue;
    const reviewPath = values[`${cohort}-review`];
    assert.ok(reviewPath, `Independent ${cohort} review required`);
    const text = await tracked(path);
    const extraReviewText = await readFile(resolve(reviewPath), "utf8");
    const extraReview = JSON.parse(extraReviewText);
    assert.equal(extraReview.approved, true);
    assert.equal(extraReview.fixtureHash, hash(text));
    const extra = buildReleaseCases(JSON.parse(text), {
      valid: 6,
      invalid: 4,
      ambiguous: 2,
    });
    extra.references.forEach((row) => {
      row.cohort = cohort;
    });
    extensions[cohort] = extra;
    extensionReviewHashes[cohort] = hash(extraReviewText);
  }
  const { heldout, regression } = extensions;
  const oldInputs = JSON.parse(await tracked(`${DATASET}/inputs.json`)) as {
    cases: InputCase[];
  };
  const oldReference = JSON.parse(
    await tracked(`${DATASET}/reference.json`),
  ) as { cases: Reference[] };
  const rebuilt = buildFilterContract(
    JSON.parse(
      await tracked("scripts/fixtures/consolidation-filter-contract.json"),
    ),
  );
  assert.deepEqual(oldInputs, rebuilt.inputs);
  assert.deepEqual(oldReference, rebuilt.reference);
  assert.equal(oldInputs.cases.length, 24);
  const sourceFixture = JSON.parse(await tracked(SOURCE_FIXTURE)) as {
    cases: (InputCase & {
      category: string;
      expectedVerdict: "pass" | "fail";
      rationale: string;
      proof: { location: "before" | "after" | "evidence"; quote: string }[];
    })[];
  };
  assert.equal(sourceFixture.cases.length, 12);
  const allInput = [
    ...oldInputs.cases,
    ...built.inputs,
    ...(regression?.inputs ?? []),
    ...(heldout?.inputs ?? []),
  ].sort((a, b) => hash(a.inputHash).localeCompare(hash(b.inputHash)));
  const allReference: Reference[] = [
    ...oldReference.cases.map((r) => ({
      ...r,
      originId: r.caseId,
      cohort: "existing" as const,
      category: r.expectedDecision === "accept" ? "valid" : "invalid",
    })),
    ...built.references,
    ...(regression?.references ?? []),
    ...(heldout?.references ?? []),
  ];
  const inputs = allInput.map((row, i) => ({
    ...row,
    caseId: `G${String(i + 1).padStart(2, "0")}`,
  }));
  const references = inputs.map((input) => {
    const r = allReference.find((r) => r.inputHash === input.inputHash);
    assert.ok(r);
    return { ...r, caseId: input.caseId };
  });
  const supportInputs = [...sourceFixture.cases]
    .sort((a, b) => hash(a.inputHash).localeCompare(hash(b.inputHash)))
    .map((r, i) => ({
      caseId: `S${String(i + 1).padStart(2, "0")}`,
      inputHash: r.inputHash,
      input: r.input,
    }));
  const supportReferences: Reference[] = supportInputs.map((i) => {
    const r = sourceFixture.cases.find((r) => r.inputHash === i.inputHash);
    assert.ok(r);
    for (const p of r.proof)
      assert.ok(
        allStrings(r.input[p.location]).some((text) => text.includes(p.quote)),
      );
    return {
      caseId: i.caseId,
      inputHash: i.inputHash,
      originId: r.caseId,
      cohort: "source-only",
      category: r.category,
      label: r.category,
      expectedCriteria: {
        [SOURCE]: { verdict: r.expectedVerdict, rationale: r.rationale },
      },
      rationale: r.rationale,
      proof: r.proof,
    };
  });
  for (const row of [...inputs, ...supportInputs]) {
    assert.equal(row.inputHash, hash(JSON.stringify(row.input)));
    assert.deepEqual(Object.keys(row.input).sort(), [
      "after",
      "before",
      "evidence",
      "operation",
    ]);
  }
  assert.equal(
    new Set([...inputs, ...supportInputs].map((i) => i.inputHash)).size,
    48 + (heldout?.inputs.length ?? 0) + (regression?.inputs.length ?? 0),
  );
  const frozenInputs = { cases: inputs, sourceOnly: supportInputs },
    frozenReference = {
      cases: references,
      sourceOnly: supportReferences,
      missingCriterionPolicy: "not_scored",
    };
  const codeHashes: Record<string, string> = {};
  for (const file of [
    "scripts/evaluate-consolidation-release.ts",
    "scripts/consolidation-evaluation-diagnostics.ts",
    "scripts/prepare-filter-contract.ts",
    "lib/maintenance/consolidation-candidate.ts",
    "lib/maintenance/consolidation-links.ts",
    "lib/maintenance/consolidation-proposals.ts",
    "lib/maintenance/consolidation-producer.ts",
    "lib/maintenance/consolidation-defect-questions.ts",
    "lib/maintenance/consolidation-rubric.ts",
    "lib/maintenance/jev.ts",
    "lib/maintenance/jev-recovery.ts",
    "lib/maintenance/jev-state.ts",
    "lib/maintenance/kimi-evaluator.ts",
    "lib/maintenance/kimi-source-contract.ts",
    "lib/maintenance/kimi-source-audit.ts",
    "lib/maintenance/kimi-source-challenge.ts",
    "lib/maintenance/kimi-utility.ts",
    "lib/maintenance/gateway.ts",
    "package.json",
    "pnpm-lock.yaml",
  ])
    codeHashes[file] = hash(await readFile(join(ROOT, file)));
  const contract = {
    version: 1,
    inputHashes,
    codeHashes,
    reviewHash: hash(reviewText),
    heldoutReviewHash: extensionReviewHashes.heldout ?? null,
    regressionReviewHash: extensionReviewHashes.regression ?? null,
    inputsHash: hash(json(frozenInputs)),
    referenceHash: hash(json(frozenReference)),
    policyVersion: CANDIDATE_POLICY_VERSION,
    policyHash: CANDIDATE_POLICY_HASH,
    bands: CANDIDATE_BANDS,
    questions: DEFECT_CONSOLIDATION_QUESTIONS,
    rubric: CONSOLIDATION_QUESTIONS_V2,
    jevModel: JEV_MODEL,
    jevRecovery: JEV_RECOVERY,
    jevStateEncoding: JEV_STATE_ENCODING,
    kimiSettings: KIMI_EVALUATOR_SETTINGS,
    clarification: KIMI_SOURCE_CONTRACT_CLARIFICATION,
    sourceReview: KIMI_SOURCE_CONTRACT,
    sourceAudit: KIMI_SOURCE_AUDIT_CONTRACT,
    preservationInstructions: KIMI_PRESERVATION_INSTRUCTIONS,
    utilityInstructions: KIMI_UTILITY_INSTRUCTIONS,
    sourceChallenge: KIMI_SOURCE_CHALLENGE_CONTRACT,
    globalCases: inputs.length,
    sourceOnlyCases: 12,
    repetitions: 3,
    expectedFreshJevCalls: inputs.length * 3,
    fixedSourceOnlyKimiEvaluations: 36,
    maximumCallsPerKimiEvaluation: KIMI_SOURCE_CONTRACT.physicalCalls,
    maximumCalls:
      inputs.length *
        3 *
        (JEV_RECOVERY.maxAttempts + KIMI_SOURCE_CONTRACT.physicalCalls) +
      36 * KIMI_SOURCE_CONTRACT.physicalCalls,
    concurrency: 3,
    maximumAttemptsPerJevEvaluation: JEV_RECOVERY.maxAttempts,
    budget: {
      maxRecordedUsdBeforeStartingAnotherCall: 5,
      maxRuntimeMs: 90 * 60_000,
      note: "Recorded USD cap is checked before each fresh call; at most 3 already-running evaluations (one Kimi call each) may finish above it. Missing costs remain unknown, never zero. Each explicit transient Jev HTTP failure may be retried within the frozen limit; each attempt has a separate receipt. Returned judgments are never retried. A single Kimi response judges the selected gray criteria; source support is derived from its checked association ledger.",
    },
    design: `${inputs.length * 3} fresh complete Jev-to-Kimi cascades, no response reuse across repetitions, plus 36 independent clarified Kimi source-only regressions. Blind IDs and fixed deterministic mixed order; only before/after/evidence/operation reach models. Reference labels never enter prompts.`,
    success:
      "All global operational decisions correct, no wrong definitive pass/fail on explicitly labeled criteria in Jev/Kimi/cascade, no ambiguous proposal applied, all36 source-only judgments correct, zero unresolved technical errors. Recovered HTTP failures remain counted separately, including unknown costs. Criteria not evaluated because another criterion already rejected remain separate and do not count as judgments.",
    ambiguity:
      "Every case explicitly labeled do_not_apply admits reject OR uncertain globally, including invalid cases with that label. This tests non-application, not perfect separation of fail versus uncertain. A criterion labeled fail still records uncertain separately from a correct definitive judgment.",
    limitations:
      "Small correlated development corpus, fixed 3 repeats; no post-output tuning and no production reliability estimate. Source-only cases have no invented global acceptance label.",
  };
  await mkdir(output, { recursive: true, mode: 0o700 });
  const lock = join(output, ".lock");
  await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  try {
    const existing = await optional(join(output, "protocol.json"));
    if (mode !== "prepare")
      assert.ok(existing, "Freeze prepare protocol before calls");
    const protocol = existing
      ? JSON.parse(existing)
      : { frozenAt: new Date().toISOString(), contract };
    assert.deepEqual(
      protocol.contract,
      contract,
      "Frozen contract/code changed",
    );
    await immutable(join(output, "protocol.json"), protocol);
    await immutable(join(output, "inputs.json"), frozenInputs);
    await immutable(join(output, "reference.json"), frozenReference);
    if (mode === "prepare") {
      console.log(
        json({
          status: "prepared",
          globalCalls: contract.expectedFreshJevCalls,
          directKimiCalls: 36,
          maximumCalls: contract.maximumCalls,
          protocolHash: hash(json(protocol)),
        }),
      );
      return;
    }
    if (mode === "run") {
      loadEnvConfig(ROOT);
      assert.ok(
        process.env.AI_GATEWAY_API_KEY?.trim(),
        "AI Gateway key unavailable",
      );
    }
    const receiptDir = join(output, "receipts");
    await mkdir(receiptDir, { recursive: true, mode: 0o700 });
    const names = await readdir(receiptDir);
    for (const name of names.filter((n) => n.endsWith(".started")))
      assert.ok(
        names.includes(name.slice(0, -8)),
        `Unknown prior provider outcome: ${name}; no retry`,
      );
    const receipts = new Map<
      string,
      Receipt<ConsolidationEvaluation | KimiEvaluation>
    >();
    for (const name of names.filter((n) => n.endsWith(".json")))
      receipts.set(
        name,
        JSON.parse(await readFile(join(receiptDir, name), "utf8")),
      );
    let freshStarted = 0;
    const initialCalls = accounting([...receipts.values()]).calls,
      runStart = Date.now();
    const consumed = new Set<string>(),
      protocolHash = hash(json(protocol));
    const globalRows: GlobalRow[] = [],
      sourceRows: SourceRow[] = [];
    const jobs = Array.from({ length: 3 }, (_, index) => [
      ...inputs.map((item) => ({
        item,
        repetition: index + 1,
        sourceOnly: false,
      })),
      ...supportInputs.map((item) => ({
        item,
        repetition: index + 1,
        sourceOnly: true,
      })),
    ])
      .flat()
      .sort((a, b) =>
        hash(`${a.item.caseId}/${a.repetition}`).localeCompare(
          hash(`${b.item.caseId}/${b.repetition}`),
        ),
      );
    let next = 0,
      completed = 0,
      fatal: unknown;
    async function call<T extends ConsolidationEvaluation | KimiEvaluation>(
      item: InputCase,
      jobId: string,
      kind: ReceiptIdentity["kind"],
      selected: Criterion[],
      fn: () => Promise<T>,
      attempt?: number,
      onReceipt?: (receipt: Receipt<T>) => void,
    ) {
      const name = `${jobId}-${kind}${attempt === undefined ? "" : `-a${attempt}`}.json`;
      try {
        const receipt = await recordedCall(
          join(receiptDir, name),
          {
            protocolHash,
            jobId,
            kind,
            inputHash: item.inputHash,
            selected,
            ...(attempt === undefined ? {} : { attempt }),
          },
          mode as "run" | "verify",
          fn,
          () => {
            assert.ok(
              !fatal,
              "Another worker encountered an integrity/budget failure",
            );
            assert.ok(
              initialCalls +
                freshStarted +
                (kind === "jev" ? 1 : contract.maximumCallsPerKimiEvaluation) <=
                contract.maximumCalls,
              "Call budget reached",
            );
            assert.ok(
              Date.now() - runStart < contract.budget.maxRuntimeMs,
              "Run duration budget reached",
            );
            assert.ok(
              accounting([...receipts.values()]).knownCostUsd <
                contract.budget.maxRecordedUsdBeforeStartingAnotherCall,
              "Recorded USD budget reached",
            );
            freshStarted +=
              kind === "jev" ? 1 : contract.maximumCallsPerKimiEvaluation;
          },
        );
        receipts.set(name, receipt);
        consumed.add(name);
        onReceipt?.(receipt);
        return receipt.outcome;
      } catch (error) {
        fatal = error;
        throw error;
      }
    }
    const diagnoseKimi = (jobId: string, input: Input, selected: Criterion[]) =>
      withKimiFailureDiagnostic(
        join(output, "diagnostics", `${jobId}.json`),
        (send) =>
          evaluateWithKimiSourceContract(input, selected, "clarified", {
            fetch: send,
          }),
      );
    const workers = await Promise.allSettled(
      Array.from({ length: 3 }, async () => {
        while (next < jobs.length && !fatal) {
          const { item, repetition, sourceOnly } = jobs[next++],
            jobId = `${item.caseId}-r${repetition}`;
          if (sourceOnly) {
            const reference = supportReferences.find(
              (r) => r.caseId === item.caseId,
            );
            assert.ok(reference);
            const outcome = await call(
              item,
              jobId,
              "source-kimi",
              [SOURCE],
              () => diagnoseKimi(jobId, item.input, [SOURCE]),
            );
            sourceRows.push({
              ...reference,
              repetition,
              jobId,
              outcome,
              verdict:
                outcome.status === "success"
                  ? (outcome.result.judgments[SOURCE]?.verdict ?? "error")
                  : "error",
            });
          } else {
            const reference = references.find((r) => r.caseId === item.caseId);
            assert.ok(reference);
            const result = await evaluateCandidate(item.input, {
              jev: async (clean) => {
                assert.deepEqual(clean, item.input);
                return recoverRecordedJevTransport(
                  async (attempt, timeoutMs) => {
                    let captured: Receipt<ConsolidationEvaluation> | undefined;
                    await call(
                      item,
                      jobId,
                      "jev",
                      [],
                      () =>
                        evaluateConsolidationProposal(clean, {
                          questions: DEFECT_CONSOLIDATION_QUESTIONS,
                          timeoutMs,
                        }),
                      attempt,
                      (receipt) => {
                        captured = receipt;
                      },
                    );
                    assert.ok(captured);
                    return captured;
                  },
                  mode as "run" | "verify",
                );
              },
              kimi: async (clean, selected) => {
                assert.deepEqual(clean, item.input);
                return resultOrThrow(
                  await call(item, jobId, "kimi", selected, () =>
                    diagnoseKimi(jobId, clean, selected),
                  ),
                );
              },
            });
            if (fatal) throw fatal;
            globalRows.push({ ...reference, repetition, jobId, ...result });
          }
          console.log(
            json({
              completed: ++completed,
              total: jobs.length,
              jobId,
              scope: sourceOnly ? "source-only" : "cascade",
            }).trim(),
          );
        }
      }),
    );
    for (const worker of workers)
      if (worker.status === "rejected") throw worker.reason;
    if (fatal) throw fatal;
    assert.equal(
      consumed.size,
      receipts.size,
      "Unexpected receipt not referenced by frozen jobs",
    );
    globalRows.sort(
      (a, b) => a.caseId.localeCompare(b.caseId) || a.repetition - b.repetition,
    );
    sourceRows.sort(
      (a, b) => a.caseId.localeCompare(b.caseId) || a.repetition - b.repetition,
    );
    assert.equal(globalRows.length, contract.expectedFreshJevCalls);
    assert.equal(sourceRows.length, 36);
    const global = summarizeReleaseRows(globalRows);
    const regressionSummary = (rows: SourceRow[]) => ({
      total: rows.length,
      correct: rows.filter(
        (r) => r.verdict === r.expectedCriteria[SOURCE]?.verdict,
      ).length,
      falsePass: rows.filter(
        (r) =>
          r.verdict === "pass" &&
          r.expectedCriteria[SOURCE]?.verdict === "fail",
      ).length,
      falseFail: rows.filter(
        (r) =>
          r.verdict === "fail" &&
          r.expectedCriteria[SOURCE]?.verdict === "pass",
      ).length,
      uncertain: rows.filter((r) => r.verdict === "uncertain").length,
      errors: rows.filter((r) => r.verdict === "error").length,
    });
    const repetitions = [1, 2, 3].map((repetition) => ({
      repetition,
      global: summarizeReleaseRows(
        globalRows.filter((r) => r.repetition === repetition),
      ),
      sourceOnly: regressionSummary(
        sourceRows.filter((r) => r.repetition === repetition),
      ),
    }));
    const repeatability = inputs.map((i) => {
      const rows = globalRows.filter((r) => r.caseId === i.caseId);
      return {
        caseId: i.caseId,
        originId: rows[0].originId,
        decisions: rows.map((r) => r.finalDecision),
        routes: rows.map((r) => r.route),
        stableDecision: new Set(rows.map((r) => r.finalDecision)).size === 1,
        stableRoute: new Set(rows.map((r) => r.route)).size === 1,
        scoreRanges: Object.fromEntries(
          CRITERIA.map((key) => {
            const scores = rows.flatMap((r) => (r.risk ? [r.risk[key]] : []));
            return [
              key,
              scores.length
                ? { min: Math.min(...scores), max: Math.max(...scores) }
                : null,
            ];
          }),
        ),
      };
    });
    const sourceOnly = regressionSummary(sourceRows),
      allReceipts = [...receipts.values()];
    const costs = {
      total: accounting(allReceipts),
      jev: accounting(allReceipts.filter((r) => r.identity.kind === "jev")),
      cascadeKimi: accounting(
        allReceipts.filter((r) => r.identity.kind === "kimi"),
      ),
      sourceOnlyKimi: accounting(
        allReceipts.filter((r) => r.identity.kind === "source-kimi"),
      ),
    };
    const wrongCriterion = Object.values(global.byCriterion).some(
      (c) =>
        c.jev.wrongDefinitive > 0 ||
        c.kimi.wrongDefinitive > 0 ||
        c.cascade.wrongDefinitive > 0,
    );
    const success =
      global.correct === contract.expectedFreshJevCalls &&
      global.errors === 0 &&
      !wrongCriterion &&
      sourceOnly.correct === 36 &&
      sourceOnly.errors === 0;
    const result = {
      protocolHash,
      status: "completed",
      success,
      global,
      sourceOnly,
      repetitions,
      cohorts: Object.fromEntries(
        ["existing", "new", "regression", "heldout"].map((c) => [
          c,
          summarizeReleaseRows(globalRows.filter((r) => r.cohort === c)),
        ]),
      ),
      categories: Object.fromEntries(
        ["valid", "invalid", "ambiguous"].map((c) => [
          c,
          summarizeReleaseRows(globalRows.filter((r) => r.category === c)),
        ]),
      ),
      costs,
      repeatability,
      sourceRepeatability: supportInputs.map((i) => ({
        caseId: i.caseId,
        verdicts: sourceRows
          .filter((r) => r.caseId === i.caseId)
          .map((r) => r.verdict),
      })),
      cases: globalRows,
      sourceCases: sourceRows,
      receiptHashes: Object.fromEntries(
        [...receipts.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, receipt]) => [name, hash(json(receipt))]),
      ),
    };
    await immutable(join(output, "results.json"), result);
    const lines = [
      "# Validazione della candidata Jev + Kimi",
      "",
      `Esito dei criteri congelati: **${success ? "superati" : "NON superati"}**.`,
      "",
      `${contract.expectedFreshJevCalls} cascate complete nuove (${inputs.length} casi × 3) e 36 regressioni Kimi del solo supporto. Nessuna risposta riutilizzata tra ripetizioni. DeepSeek non è in questo test.`,
      "",
      "| Ripetizione | Esiti globali corretti | False accettazioni | False bocciature | Incerti | Errori | Deleghe Kimi | Supporto diretto corretto |",
      "|---|---:|---:|---:|---:|---:|---:|---:|",
      ...repetitions.map(
        (r) =>
          `| ${r.repetition} | ${r.global.correct}/${inputs.length} | ${r.global.falseAccept} | ${r.global.falseReject} | ${r.global.uncertain} | ${r.global.errors} | ${r.global.kimiCalls} | ${r.sourceOnly.correct}/12 |`,
      ),
      "",
      "I casi con etichetta globale do_not_apply ammettono reject o uncertain, anche quando classificati invalidi: misurano la non-applicazione. Sui criteri etichettati fail, uncertain resta distinto da un giudizio definitivo corretto. I tentativi tecnici falliti restano conteggiati anche quando il recupero riesce. Criteri privi di etichetta restano not_scored; grigi non interrogati dopo un rosso restano not_evaluated.",
      "",
      "| Criterio / metodo | Etichette | Corretti | Decisioni definitive errate | Delegati | Incerti | Non valutati | Errori |",
      "|---|---:|---:|---:|---:|---:|---:|---:|",
      ...CRITERIA.flatMap((key) =>
        ["jev", "kimi", "cascade"].map((method) => {
          const c = global.byCriterion[key],
            s = c[method as "jev" | "kimi" | "cascade"];
          return `| ${key} / ${method} | ${c.labeled} | ${s.correct} | ${s.wrongDefinitive} | ${s.deferred} | ${s.uncertain} | ${s.notEvaluated} | ${s.errors} |`;
        }),
      ),
      "",
      `Decisione identica nelle tre ripetizioni: ${repeatability.filter((r) => r.stableDecision).length}/${inputs.length} casi. Percorso Jev identico: ${repeatability.filter((r) => r.stableRoute).length}/${inputs.length}.`,
      "",
      `Costo comunicato dal provider: $${costs.total.knownCostUsd}; chiamate senza costo disponibile: ${costs.total.missingCosts}/${costs.total.calls}. Sono importi noti, non una stima dei valori mancanti.`,
      "",
      "## Casi e ripetizioni",
      "",
      "| Caso cieco / origine | Ripetizione | Atteso | Percorso Jev | Finale | Deleghe |",
      "|---|---:|---|---|---|---|",
      ...globalRows.map(
        (r) =>
          `| ${r.caseId} / ${r.originId} | ${r.repetition} | ${r.expectedDecision} | ${r.route} | ${r.finalDecision} | ${r.selected.join(", ") || "—"} |`,
      ),
      "",
      "## Evidenza",
      "",
      "protocol.json congela codice, domande, soglie e input/reference separati. results.json contiene punteggi, motivazioni, segmentazione completa e hash di tutte le ricevute. Ogni ricevuta conserva inizio/fine, identità, output analizzato e costo riportato. Non si conservano credenziali o reasoning del provider. verify ricostruisce tutto dalle ricevute senza chiamate.",
      "",
      "I casi sono piccoli e correlati: tre ripetizioni non costituiscono una stima di affidabilità in produzione. Nessuna soglia o domanda è stata adattata ai risultati di questa esecuzione.",
    ];
    const report = `${lines.join("\n")}\n`,
      savedReport = await optional(join(output, "rapporto.md"));
    if (savedReport !== undefined) assert.equal(savedReport, report);
    else
      await writeFile(join(output, "rapporto.md"), report, {
        flag: "wx",
        mode: 0o600,
      });
    console.log(
      json({
        status: "completed",
        success,
        globalCorrect: global.correct,
        sourceCorrect: sourceOnly.correct,
        costs: costs.total,
      }),
    );
  } finally {
    await rm(lock, { force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Release validation failed",
    );
    process.exitCode = 1;
  });
