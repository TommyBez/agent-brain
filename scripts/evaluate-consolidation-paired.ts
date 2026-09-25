import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadEnvConfig } from "@next/env";
import { z } from "zod";
import type { BrainPage } from "../lib/brain/types";
import {
  applyPositiveConsolidationPolicy,
  type PositiveConsolidationEvaluation,
} from "../lib/maintenance/consolidation-policy";
import {
  proposeConsolidation,
  validateAndApplyProposal,
} from "../lib/maintenance/consolidation-proposals";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import {
  type ConsolidationEvaluationInput,
  evaluateConsolidationProposal,
  JEV_CONSOLIDATION_THRESHOLDS,
} from "../lib/maintenance/jev";

// This isolated experiment reads local snapshots and calls the Gateway only.
// The assistant's frozen blind judgments are shadow labels, never a write gate.
const criterionSchema = z.strictObject({
  verdict: z.enum(["pass", "fail", "uncertain"]),
  rationale: z.string().trim().min(1).max(10_000),
});
export const assistantReviewSchema = z.strictObject({
  pass: z.number().int().positive(),
  reviewer: z.literal("assistant"),
  candidates: z.array(
    z.strictObject({
      candidateId: z.string().min(1),
      inputHash: z.string().regex(/^[a-f0-9]{64}$/),
      familyId: z.string().trim().min(1).max(150),
      criteria: z.strictObject({
        supported_by_evidence: criterionSchema,
        preserves_distinct_information: criterionSchema,
        no_new_human_action: criterionSchema,
        meaningful_improvement: criterionSchema,
      }),
    }),
  ),
});
type AssistantReview = z.infer<typeof assistantReviewSchema>;
type Generation = Awaited<ReturnType<typeof proposeConsolidation>>;
type BlindCandidate = {
  candidateId: string;
  proposalIndex: number;
  inputHash: string;
  input: ConsolidationEvaluationInput;
};
type BlindRequest = {
  pass: number;
  beforeHash: string;
  generationHash: string;
  candidates: BlindCandidate[];
};
type EvaluationReceipt = {
  inputHash: string;
  reviewHash: string;
  evaluatedAt: string;
  result: PositiveConsolidationEvaluation;
};

function hash(value: unknown) {
  return hashText(JSON.stringify(value));
}
function hashText(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}
async function save(path: string, data: unknown) {
  await writeFile(`${path}.tmp`, `${JSON.stringify(data, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(`${path}.tmp`, 0o600);
  await rename(`${path}.tmp`, path);
}
async function keepImmutable(path: string, data: unknown) {
  const existing = await readOptional(path);
  if (existing === undefined) await save(path, data);
  else if (hash(JSON.parse(existing)) !== hash(data))
    throw new Error(`Saved artifact differs from expected inputs: ${path}`);
}
function safeError(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown error";
}
function evaluationContent(page: BrainPage) {
  return {
    title: page.title,
    type: page.type,
    summary: page.summary,
    markdown: page.markdown,
    aliases: page.aliases,
    tags: page.tags,
    links: page.links.map(({ targetSlug, targetTitle, type, label }) => ({
      targetSlug,
      targetTitle,
      type,
      label,
    })),
  };
}
function evaluationInput(
  candidate: ReturnType<typeof validateAndApplyProposal>,
  operation: Generation["proposals"][number],
): ConsolidationEvaluationInput {
  return {
    before: evaluationContent(candidate.before),
    after: evaluationContent(candidate.after),
    evidence: candidate.evidence,
    operation,
  };
}
async function retry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof GatewayRequestError) ||
        !error.retryable ||
        attempt >= 3
      )
        throw error;
      await new Promise((done) =>
        setTimeout(
          done,
          Math.min(error.retryAfterMs ?? 1000 * attempt, 30_000),
        ),
      );
    }
  }
}

export function validateAssistantReview(
  raw: unknown,
  request: BlindRequest,
): AssistantReview {
  const review = assistantReviewSchema.parse(raw);
  if (review.pass !== request.pass)
    throw new Error("Assistant review refers to a different pass.");
  const expected = new Map(
    request.candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  if (review.candidates.length !== expected.size)
    throw new Error("Every candidate must have exactly one assistant review.");
  for (const candidate of review.candidates) {
    const input = expected.get(candidate.candidateId);
    if (!input || input.inputHash !== candidate.inputHash)
      throw new Error(
        "Assistant review candidate or input hash does not match.",
      );
    expected.delete(candidate.candidateId);
  }
  return review;
}

type RunOptions = {
  snapshot: string;
  output: string;
  passes: number;
  model?: string;
};
type Dependencies = {
  propose?: typeof proposeConsolidation;
  evaluate?: typeof evaluateConsolidationProposal;
};

export async function runPairedExperiment(
  options: RunOptions,
  dependencies: Dependencies = {},
) {
  if (
    !Number.isInteger(options.passes) ||
    options.passes < 1 ||
    options.passes > 20
  )
    throw new Error("Passes must be an integer between 1 and 20.");
  const output = resolve(options.output);
  await mkdir(output, { recursive: true, mode: 0o700 });
  await chmod(output, 0o700);
  let activePass = 0;
  try {
    const source = JSON.parse(
      await readFile(resolve(options.snapshot), "utf8"),
    ) as {
      capturedAt: string;
      pages: BrainPage[];
    };
    if (
      !source.pages?.length ||
      source.pages.some((page) => !page.markdown || !page.id)
    )
      throw new Error("Snapshot has no complete pages.");
    const model =
      options.model ??
      process.env.CONSOLIDATION_MODEL ??
      "deepseek/deepseek-v4.1-flash";
    const codeHashes: Record<string, string> = {};
    for (const file of [
      "scripts/evaluate-consolidation-paired.ts",
      "lib/maintenance/consolidation-proposals.ts",
      "lib/maintenance/consolidation-policy.ts",
      "lib/maintenance/jev.ts",
      "package.json",
      "pnpm-lock.yaml",
      "lib/maintenance/gateway.ts",
    ])
      codeHashes[file] = hashText(await readFile(resolve(file)));
    const protocol = {
      version: 1,
      snapshotCapturedAt: source.capturedAt,
      completeSnapshotHash: hash(source),
      pageCount: source.pages.length,
      passes: options.passes,
      model,
      codeHashes,
      evaluationSpecHash: hashText(
        await readFile(resolve(output, "evaluation-spec.json")),
      ),
      thresholds: JEV_CONSOLIDATION_THRESHOLDS,
      design:
        "Sequential full-corpus reconsideration. Assistant reviews exact candidate inputs before any Jev call in each pass. Review is frozen; assistant judgments are shadow labels. Only unchanged Jev thresholds control state advances. No production writes.",
      limitations:
        "One stochastic trajectory. No new evidence. This evaluates content transformations, not retrieval ranking, indexing, database concurrency or scheduled Workflow execution. Assistant judgments are a reference, not ground truth.",
    };
    await keepImmutable(resolve(output, "protocol.json"), protocol);
    let pages = structuredClone(source.pages);
    const records: Array<{
      pass: number;
      proposed: number;
      applied: number;
      validationRejected: number;
      schemaRejected: number;
      jevCalls: number;
      assistantWouldPass: number;
      agreements: number;
      generationFault: string | null;
      usage: Generation["usage"];
      afterHash: string;
      corpusCharacters: number;
    }> = [];
    const propose = dependencies.propose ?? proposeConsolidation;
    const evaluate = dependencies.evaluate ?? evaluateConsolidationProposal;

    for (let pass = 1; pass <= options.passes; pass++) {
      activePass = pass;
      const number = String(pass).padStart(2, "0");
      const path = (name: string) => resolve(output, `${name}-${number}.json`);
      const completedText = await readOptional(path("pass"));
      const completed =
        completedText === undefined ? undefined : JSON.parse(completedText);
      const beforeHash = hash(pages);
      const passStartPages = structuredClone(pages);
      const generationText = await readOptional(path("generation"));
      if (completed && generationText === undefined)
        throw new Error("Completed pass is missing its generation receipt.");
      const generation =
        generationText === undefined
          ? {
              pass,
              beforeHash,
              startedAt: new Date().toISOString(),
              generated: await retry(() => propose(passStartPages, { model })),
              generatedAt: new Date().toISOString(),
            }
          : (JSON.parse(generationText) as {
              pass: number;
              beforeHash: string;
              startedAt: string;
              generatedAt: string;
              generated: Generation;
            });
      if (generation.pass !== pass || generation.beforeHash !== beforeHash)
        throw new Error("Saved generation does not match its pass snapshot.");
      if (generationText === undefined)
        await save(path("generation"), generation);
      const generated = generation.generated;
      const candidates: BlindCandidate[] = [];
      const validationRejected: Array<{
        proposalIndex: number;
        error: string;
      }> = [];
      const targetPages = new Set<string>();
      for (const [proposalIndex, proposal] of generated.proposals.entries()) {
        try {
          if (targetPages.has(proposal.pageId))
            throw new Error(
              "Multiple proposals for one target page in the same pass.",
            );
          targetPages.add(proposal.pageId);
          const candidate = validateAndApplyProposal(
            passStartPages,
            proposal,
            passStartPages,
          );
          if (!candidate.changed)
            throw new Error("Proposal does not change the page.");
          const input = evaluationInput(candidate, proposal);
          const inputHash = hash(input);
          candidates.push({
            candidateId: `p${number}-c${String(proposalIndex + 1).padStart(2, "0")}-${inputHash.slice(0, 12)}`,
            proposalIndex,
            inputHash,
            input,
          });
        } catch (error) {
          validationRejected.push({ proposalIndex, error: safeError(error) });
        }
      }
      const request: BlindRequest = {
        pass,
        beforeHash,
        generationHash: hash(generation),
        candidates,
      };
      await keepImmutable(path("blind-request"), request);
      const requestHash = hash(request);
      const reviewText = await readOptional(path("assistant-review"));
      const frozenText = await readOptional(path("review-frozen"));
      const evaluationText = await readOptional(path("jev-evaluations"));
      if (candidates.length && reviewText === undefined) {
        if (
          completed ||
          frozenText !== undefined ||
          evaluationText !== undefined
        )
          throw new Error(
            "A previously reviewed pass is missing its assistant review.",
          );
        const status = {
          status: "awaiting_review" as const,
          pass,
          completedPasses: records.length,
          candidates: candidates.length,
          request: path("blind-request"),
          review: path("assistant-review"),
        };
        await save(resolve(output, "status.json"), status);
        return status;
      }
      let review: AssistantReview = {
        pass,
        reviewer: "assistant",
        candidates: [],
      };
      let reviewHash: string | null = null;
      if (reviewText !== undefined) {
        review = validateAssistantReview(JSON.parse(reviewText), request);
        reviewHash = hashText(reviewText);
        await chmod(path("assistant-review"), 0o600);
      }
      const frozen =
        frozenText === undefined
          ? {
              pass,
              requestHash,
              reviewHash,
              frozenAt: new Date().toISOString(),
            }
          : (JSON.parse(frozenText) as {
              pass: number;
              requestHash: string;
              reviewHash: string | null;
              frozenAt: string;
            });
      if (
        frozen.pass !== pass ||
        frozen.requestHash !== requestHash ||
        frozen.reviewHash !== reviewHash
      )
        throw new Error(
          "A frozen assistant review or its blind request has changed.",
        );
      if (frozenText === undefined) {
        if (completed || evaluationText !== undefined)
          throw new Error(
            "Jev receipts exist without an earlier frozen assistant review.",
          );
        await save(path("review-frozen"), frozen);
      }
      const evaluations: Record<string, EvaluationReceipt> =
        evaluationText === undefined ? {} : JSON.parse(evaluationText);
      const knownCandidateIds = new Set(
        candidates.map((candidate) => candidate.candidateId),
      );
      if (Object.keys(evaluations).some((id) => !knownCandidateIds.has(id)))
        throw new Error("Saved Jev evaluations include an unknown candidate.");
      const decisions = [];
      for (const candidate of candidates) {
        // Recheck the frozen file before each paid request, including after resume.
        const currentReview = await readFile(path("assistant-review"), "utf8");
        if (hashText(currentReview) !== reviewHash)
          throw new Error("Assistant review changed after it was frozen.");
        const assistant = review.candidates.find(
          (item) => item.candidateId === candidate.candidateId,
        );
        if (!assistant || !reviewHash)
          throw new Error("Candidate has no frozen assistant review.");
        const proposal = generated.proposals[candidate.proposalIndex];
        const patch = validateAndApplyProposal(pages, proposal, passStartPages);
        if (hash(evaluationInput(patch, proposal)) !== candidate.inputHash)
          throw new Error("Candidate input changed after blind review.");
        let evaluation = evaluations[candidate.candidateId];
        if (
          evaluation &&
          (evaluation.inputHash !== candidate.inputHash ||
            evaluation.reviewHash !== reviewHash)
        )
          throw new Error(
            "Saved Jev evaluation does not match its reviewed input.",
          );
        if (!evaluation) {
          if (completed)
            throw new Error("Completed pass is missing a Jev receipt.");
          const result = applyPositiveConsolidationPolicy(
            await retry(() => evaluate(candidate.input)),
          );
          evaluation = {
            inputHash: candidate.inputHash,
            reviewHash,
            evaluatedAt: new Date().toISOString(),
            result,
          };
          evaluations[candidate.candidateId] = evaluation;
          await save(path("jev-evaluations"), evaluations);
        }
        if (
          hashText(await readFile(path("assistant-review"), "utf8")) !==
          reviewHash
        )
          throw new Error("Assistant review changed while Jev was evaluating.");
        const assistantWouldPass = Object.values(assistant.criteria).every(
          (criterion) => criterion.verdict === "pass",
        );
        const criterionComparison = Object.entries(
          JEV_CONSOLIDATION_THRESHOLDS,
        ).map(([criterion, threshold]) => {
          const assistantVerdict =
            assistant.criteria[criterion as keyof typeof assistant.criteria]
              .verdict;
          const jevProbability = evaluation.result.answers[criterion];
          const jevPass = jevProbability >= threshold;
          return {
            criterion,
            threshold,
            assistantVerdict,
            jevProbability,
            jevPass,
            agrees:
              assistantVerdict === "uncertain"
                ? null
                : (assistantVerdict === "pass") === jevPass,
          };
        });
        if (evaluation.result.allowed) pages = patch.pages;
        decisions.push({
          candidateId: candidate.candidateId,
          proposalIndex: candidate.proposalIndex,
          inputHash: candidate.inputHash,
          assistant,
          assistantWouldPass,
          jev: evaluation.result,
          accepted: evaluation.result.allowed,
          agrees: assistantWouldPass === evaluation.result.allowed,
          criterionComparison,
        });
      }
      const afterHash = hash(pages);
      const totals = {
        pass,
        proposed:
          generated.proposals.length + generated.rejectedProposals.length,
        applied: decisions.filter((decision) => decision.accepted).length,
        validationRejected: validationRejected.length,
        schemaRejected: generated.rejectedProposals.length,
        jevCalls: decisions.length,
        assistantWouldPass: decisions.filter(
          (decision) => decision.assistantWouldPass,
        ).length,
        agreements: decisions.filter((decision) => decision.agrees).length,
        generationFault: generated.generationFault ?? null,
        usage: generated.usage,
        afterHash,
        corpusCharacters: pages.reduce(
          (sum, page) => sum + page.markdown.length,
          0,
        ),
      };
      const record = {
        ...totals,
        status: "completed",
        model: generated.model,
        beforeHash,
        changed: beforeHash !== afterHash,
        generationHash: hash(generation),
        requestHash,
        reviewHash,
        reviewFrozenAt: frozen.frozenAt,
        evaluationsHash: hash(evaluations),
        generationStartedAt: generation.startedAt,
        generatedAt: generation.generatedAt,
        rejectedProposals: generated.rejectedProposals,
        validationRejections: validationRejected,
        responseDiagnostics: generated.responseDiagnostics,
        decisions,
        pages,
      };
      await keepImmutable(path("pass"), record);
      records.push(totals);
      if (!completed)
        console.log(
          JSON.stringify({
            status: "pass_completed",
            pass,
            candidates: candidates.length,
            changed: record.changed,
          }),
        );
    }
    const summary = {
      status: "completed" as const,
      passes: records.length,
      model,
      proposed: records.reduce((sum, record) => sum + record.proposed, 0),
      applied: records.reduce((sum, record) => sum + record.applied, 0),
      comparedCandidates: records.reduce(
        (sum, record) => sum + record.jevCalls,
        0,
      ),
      assistantWouldPass: records.reduce(
        (sum, record) => sum + record.assistantWouldPass,
        0,
      ),
      agreements: records.reduce((sum, record) => sum + record.agreements, 0),
      validationRejected: records.reduce(
        (sum, record) => sum + record.validationRejected,
        0,
      ),
      schemaRejected: records.reduce(
        (sum, record) => sum + record.schemaRejected,
        0,
      ),
      generationFaults: records
        .filter((record) => record.generationFault)
        .map(({ pass, generationFault }) => ({ pass, generationFault })),
      usage: {
        inputTokens: records.reduce(
          (sum, record) => sum + record.usage.inputTokens,
          0,
        ),
        outputTokens: records.reduce(
          (sum, record) => sum + record.usage.outputTokens,
          0,
        ),
      },
      initialCharacters: source.pages.reduce(
        (sum, page) => sum + page.markdown.length,
        0,
      ),
      finalCharacters: pages.reduce(
        (sum, page) => sum + page.markdown.length,
        0,
      ),
      finalHash: hash(pages),
      records,
    };
    await keepImmutable(resolve(output, "summary.json"), summary);
    await keepImmutable(resolve(output, "final.json"), { pages });
    await save(resolve(output, "status.json"), {
      status: "completed",
      passes: records.length,
    });
    return summary;
  } catch (error) {
    await save(resolve(output, "failure.json"), {
      pass: activePass,
      occurredAt: new Date().toISOString(),
      error: safeError(error),
    });
    throw error;
  }
}

async function main() {
  loadEnvConfig(process.cwd());
  const { values } = parseArgs({
    options: {
      snapshot: { type: "string" },
      output: { type: "string" },
      passes: { type: "string", default: "20" },
    },
  });
  if (!values.snapshot || !values.output)
    throw new Error("Supply --snapshot and --output paths.");
  const result = await runPairedExperiment({
    snapshot: values.snapshot,
    output: values.output,
    passes: Number(values.passes),
  });
  console.log(
    JSON.stringify(
      result.status === "completed"
        ? {
            status: "completed",
            passes: result.passes,
            candidates: result.comparedCandidates,
          }
        : result,
    ),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) ===
    resolve("scripts/evaluate-consolidation-paired.ts")
) {
  void main().catch((error: unknown) => {
    console.error(safeError(error));
    process.exitCode = 1;
  });
}
