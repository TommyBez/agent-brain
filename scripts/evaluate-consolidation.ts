import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadEnvConfig } from "@next/env";
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
import { evaluateConsolidationProposal } from "../lib/maintenance/jev";

// This experiment only reads JSON and calls the Gateway. It has no database,
// MCP mutation, indexing, export, or production-workflow dependency.
async function main() {
  loadEnvConfig(process.cwd());

  const { values } = parseArgs({
    options: {
      snapshot: { type: "string" },
      output: { type: "string" },
      arm: { type: "string", default: "both" },
      passes: { type: "string", default: "20" },
    },
  });
  if (!values.snapshot || !values.output)
    throw new Error("Supply --snapshot and --output paths.");
  const passes = Number(values.passes);
  if (!Number.isInteger(passes) || passes < 1 || passes > 20)
    throw new Error("Passes must be an integer between 1 and 20.");
  if (!["a", "b", "both"].includes(values.arm))
    throw new Error("Arm must be a, b, or both.");

  const output = resolve(values.output);
  const source = JSON.parse(
    await readFile(resolve(values.snapshot), "utf8"),
  ) as {
    capturedAt: string;
    pages: BrainPage[];
  };
  if (
    !source.pages.length ||
    source.pages.some((page) => !page.markdown || !page.id)
  )
    throw new Error("Snapshot has no complete pages.");
  const model =
    process.env.CONSOLIDATION_MODEL || "deepseek/deepseek-v4.1-flash";
  let interrupted = false;

  function fingerprint(pages: BrainPage[]) {
    return createHash("sha256")
      .update(
        JSON.stringify(
          pages.map((page) => ({
            id: page.id,
            slug: page.slug,
            title: page.title,
            type: page.type,
            summary: page.summary,
            markdown: page.markdown,
            aliases: page.aliases,
            tags: page.tags,
            links: page.links.map(({ targetId, type, label }) => ({
              targetId,
              type,
              label,
            })),
          })),
        ),
      )
      .digest("hex");
  }

  async function save(path: string, data: unknown) {
    await writeFile(`${path}.tmp`, `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(`${path}.tmp`, path);
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

  function safeError(error: unknown) {
    return error instanceof Error
      ? error.message.slice(0, 500)
      : "Unknown error";
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

  async function runArm(arm: "a" | "b") {
    const directory = resolve(output, arm);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let pages = structuredClone(source.pages);
    const hashes = new Map([[fingerprint(pages), 0]]);
    const records: Record<string, unknown>[] = [];
    const total = {
      inputTokens: 0,
      outputTokens: 0,
      applied: 0,
      rejected: 0,
      jevCalls: 0,
      generationFaults: 0,
      schemaRejections: 0,
    };
    await save(resolve(directory, "initial.json"), { pages });
    for (let pass = 1; pass <= passes; pass++) {
      if (interrupted)
        throw new Error("Experiment stopped after another arm failed.");
      const path = resolve(
        directory,
        `pass-${String(pass).padStart(2, "0")}.json`,
      );
      // Completed passes are immutable receipts; a process restart resumes from them.
      try {
        const saved = JSON.parse(await readFile(path, "utf8"));
        if (saved.status !== "completed")
          throw new Error("Incomplete pass receipt.");
        pages = saved.pages;
        records.push(saved);
        total.inputTokens += saved.usage.inputTokens;
        total.outputTokens += saved.usage.outputTokens;
        total.applied += saved.applied;
        total.rejected += saved.rejected;
        total.jevCalls += saved.jevCalls;
        total.generationFaults += Number(Boolean(saved.generationFault));
        total.schemaRejections += saved.rejectedProposals?.length ?? 0;
        hashes.set(saved.fingerprint, pass);
        continue;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
      const started = Date.now();
      const beforeHash = fingerprint(pages);
      const passStartPages = structuredClone(pages);
      const proposalsPath = resolve(
        directory,
        `proposals-${String(pass).padStart(2, "0")}.json`,
      );
      let generated: Awaited<ReturnType<typeof proposeConsolidation>>;
      try {
        generated = JSON.parse(await readFile(proposalsPath, "utf8"));
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
        generated = await retry(() => proposeConsolidation(pages, { model }));
        await save(proposalsPath, generated);
      }
      const evaluationsPath = resolve(
        directory,
        `evaluations-${String(pass).padStart(2, "0")}.json`,
      );
      let evaluations: Record<
        string,
        { inputHash: string; result: PositiveConsolidationEvaluation }
      > = {};
      try {
        evaluations = JSON.parse(await readFile(evaluationsPath, "utf8"));
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
      const decisions: Record<string, unknown>[] = [];
      let applied = 0;
      let jevCalls = 0;
      const targetPages = new Set<string>();
      for (const [proposalIndex, proposal] of generated.proposals.entries()) {
        if (interrupted)
          throw new Error("Experiment stopped after another arm failed.");
        try {
          if (targetPages.has(proposal.pageId))
            throw new Error(
              "Multiple proposals for one target page in the same pass.",
            );
          targetPages.add(proposal.pageId);
          const candidate = validateAndApplyProposal(
            pages,
            proposal,
            passStartPages,
          );
          if (!candidate.changed) {
            decisions.push({ proposal, accepted: false, reason: "no_change" });
            continue;
          }
          let evaluation: PositiveConsolidationEvaluation | undefined;
          if (arm === "b") {
            jevCalls++;
            const input = {
              before: evaluationContent(candidate.before),
              after: evaluationContent(candidate.after),
              evidence: candidate.evidence,
              operation: proposal,
            };
            const inputHash = createHash("sha256")
              .update(JSON.stringify(input))
              .digest("hex");
            const cached = evaluations[String(proposalIndex)];
            if (cached && cached.inputHash !== inputHash)
              throw new GatewayRequestError(
                "Saved Jev evaluation does not match its original input.",
                { retryable: false },
              );
            evaluation =
              cached?.result ??
              applyPositiveConsolidationPolicy(
                await retry(() => evaluateConsolidationProposal(input)),
              );
            if (!cached) {
              evaluations[String(proposalIndex)] = {
                inputHash,
                result: evaluation,
              };
              await save(evaluationsPath, evaluations);
            }
            if (!evaluation.allowed) {
              decisions.push({
                proposal,
                accepted: false,
                reason: "jev_rejected",
                evaluation,
              });
              continue;
            }
          }
          pages = candidate.pages;
          applied++;
          decisions.push({
            proposal,
            accepted: true,
            ...(evaluation ? { evaluation } : {}),
          });
        } catch (error) {
          // Provider failure invalidates the experiment, not the proposal's quality.
          if (error instanceof GatewayRequestError) throw error;
          decisions.push({
            proposal,
            accepted: false,
            reason: "validation_failed",
            error: safeError(error),
          });
        }
      }
      const hash = fingerprint(pages);
      const cycleToPass =
        hash !== beforeHash && hashes.has(hash) ? hashes.get(hash) : null;
      hashes.set(hash, pass);
      const record = {
        arm,
        pass,
        status: "completed",
        model: generated.model,
        durationMs: Date.now() - started,
        usage: generated.usage,
        proposed:
          generated.proposals.length + generated.rejectedProposals.length,
        applied,
        rejected:
          generated.proposals.length +
          generated.rejectedProposals.length -
          applied,
        rejectedProposals: generated.rejectedProposals,
        generationFault: generated.generationFault ?? null,
        responseDiagnostics: generated.responseDiagnostics,
        jevCalls,
        corpusCharacters: pages.reduce(
          (sum, page) => sum + page.markdown.length,
          0,
        ),
        fingerprint: hash,
        changed: hash !== beforeHash,
        cycleToPass,
        decisions,
        pages,
      };
      records.push(record);
      total.inputTokens += generated.usage.inputTokens;
      total.outputTokens += generated.usage.outputTokens;
      total.applied += applied;
      total.rejected += record.rejected;
      total.jevCalls += jevCalls;
      total.generationFaults += Number(Boolean(generated.generationFault));
      total.schemaRejections += generated.rejectedProposals.length;
      await save(path, record);
      console.log(
        JSON.stringify({
          arm,
          pass,
          proposed: record.proposed,
          applied,
          rejected: record.rejected,
          jevCalls,
          generationFault: record.generationFault,
          schemaRejections: generated.rejectedProposals.length,
          characters: record.corpusCharacters,
          durationMs: record.durationMs,
        }),
      );
    }
    const summary = {
      arm,
      passes,
      model,
      ...total,
      finalFingerprint: fingerprint(pages),
      initialCharacters: source.pages.reduce(
        (sum, page) => sum + page.markdown.length,
        0,
      ),
      finalCharacters: pages.reduce(
        (sum, page) => sum + page.markdown.length,
        0,
      ),
      lastChangedPass:
        records.filter((record) => record.changed).at(-1)?.pass ?? 0,
      cycles: records
        .filter((record) => record.cycleToPass !== null)
        .map((record) => ({
          pass: record.pass,
          cycleToPass: record.cycleToPass,
        })),
    };
    await save(resolve(directory, "summary.json"), summary);
    await save(resolve(directory, "final.json"), { pages });
    return summary;
  }

  await mkdir(output, { recursive: true, mode: 0o700 });
  const codeHashes: Record<string, string> = {};
  for (const file of [
    "scripts/evaluate-consolidation.ts",
    "lib/maintenance/consolidation-proposals.ts",
    "lib/maintenance/consolidation-policy.ts",
    "lib/maintenance/jev.ts",
    "package.json",
    "pnpm-lock.yaml",
    "lib/maintenance/gateway.ts",
  ]) {
    codeHashes[file] = createHash("sha256")
      .update(await readFile(resolve(file)))
      .digest("hex");
  }
  const evaluationSpecHash = createHash("sha256")
    .update(await readFile(resolve(output, "evaluation-spec.json")))
    .digest("hex");
  const protocol = {
    snapshotCapturedAt: source.capturedAt,
    snapshotHash: fingerprint(source.pages),
    completeSnapshotHash: createHash("sha256")
      .update(JSON.stringify(source))
      .digest("hex"),
    pageCount: source.pages.length,
    passesPerArm: passes,
    model,
    codeHashes,
    evaluationSpecHash,
    design:
      "Sequential full-corpus reconsideration, no new evidence, no checkpoint skips. A has deterministic proposal validation; B adds the Jev gate. No production writes.",
    limitations:
      "One stochastic trajectory per arm; evaluates content transformations, not database concurrency, retrieval ranking, indexing, or scheduled Workflow execution.",
  };
  try {
    const previous = JSON.parse(
      await readFile(resolve(output, "protocol.json"), "utf8"),
    );
    if (JSON.stringify(previous) !== JSON.stringify(protocol))
      throw new Error(
        "Experiment inputs or implementation changed; use a new output directory.",
      );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  await save(resolve(output, "protocol.json"), protocol);
  const selected: ("a" | "b")[] =
    values.arm === "both" ? ["a", "b"] : [values.arm as "a" | "b"];
  const settled = await Promise.allSettled(
    selected.map(async (arm) => {
      try {
        return await runArm(arm);
      } catch (error) {
        interrupted = true;
        throw error;
      }
    }),
  );
  if (settled.some((result) => result.status === "rejected")) {
    const failures = settled.flatMap((result, index) =>
      result.status === "rejected"
        ? [{ arm: selected[index], error: safeError(result.reason) }]
        : [],
    );
    await save(resolve(output, "failure.json"), { failures });
    throw new Error(
      `Experiment interrupted: ${failures.map((failure) => `${failure.arm}: ${failure.error}`).join("; ")}`,
    );
  }
  const summaries = settled.map((result) =>
    result.status === "fulfilled" ? result.value : null,
  );
  await save(resolve(output, "summary.json"), summaries);
  console.log(JSON.stringify({ complete: true, summaries }));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Experiment failed.");
  process.exitCode = 1;
});
