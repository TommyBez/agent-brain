import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { BrainPage } from "../lib/brain/types";
import {
  CANDIDATE_BANDS,
  CANDIDATE_POLICY_HASH,
  CandidateRecordedError,
  evaluateCandidate,
  prepareCandidateProposal,
} from "../lib/maintenance/consolidation-candidate";
import type { proposeConsolidation } from "../lib/maintenance/consolidation-proposals";
import { CONSOLIDATION_CRITERIA } from "../lib/maintenance/consolidation-rubric";
import {
  CANDIDATE_RUN_LIMITS,
  type CandidateHistoryEntry,
  type runConsolidationSnapshot,
} from "../lib/maintenance/consolidation-run";
import { semanticHash } from "./run-consolidation-candidate";

type Evaluation = Awaited<ReturnType<typeof evaluateCandidate>>;
type Generation = Awaited<ReturnType<typeof proposeConsolidation>>;
type Receipt<T> = { inputHash: string; finishedAt: string; outcome: T };
type Pass = {
  pass: number;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  beforeHash: string;
  afterHash: string;
  changed: boolean;
  result: Awaited<ReturnType<typeof runConsolidationSnapshot>>;
};
type Protocol = {
  preparedAt: string;
  mode: "volume" | "preview";
  passes: number;
  initialHash: string;
  invariantHash: string | null;
  code: Record<string, string>;
  policyHash: string;
  limits: typeof CANDIDATE_RUN_LIMITS;
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fileHash = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const json = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8"));
async function exists(path: string) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Recompute the policy from saved raw answers with network adapters replaced completely. */
async function verifyEvaluation(
  input: Parameters<typeof evaluateCandidate>[0],
  saved: Evaluation,
) {
  let kimiCalled = false;
  const replayed = await evaluateCandidate(input, {
    jev: async (clean) => {
      assert.deepEqual(clean, input);
      if (saved.jev.status === "error")
        throw new CandidateRecordedError(saved.jev.error);
      return structuredClone(saved.jev.result);
    },
    kimi: async (clean, selected) => {
      kimiCalled = true;
      assert.deepEqual(clean, input);
      assert.deepEqual(selected, saved.selected);
      assert.ok(saved.kimi, "Routing requires a recorded Kimi outcome.");
      if (saved.kimi.status === "error")
        throw new CandidateRecordedError(saved.kimi.error);
      return structuredClone(saved.kimi.result);
    },
  });
  assert.deepEqual(
    replayed,
    saved,
    "The shared policy cannot reproduce its recorded decision.",
  );
  assert.equal(kimiCalled, saved.kimi !== null);
  // An independent check also protects against a mistaken implementation reused in the replay.
  if (saved.jev.status === "success") {
    const raw = saved.jev.result.answers;
    const rounded = Object.fromEntries(
      CONSOLIDATION_CRITERIA.map((key) => [key, Number(raw[key].toFixed(12))]),
    );
    assert.deepEqual(saved.risk, rounded);
    const red = CONSOLIDATION_CRITERIA.filter(
      (key) => rounded[key] >= CANDIDATE_BANDS[key].rejectAtOrAbove,
    );
    const gray = red.length
      ? []
      : CONSOLIDATION_CRITERIA.filter(
          (key) => rounded[key] >= CANDIDATE_BANDS[key].allowBelow,
        );
    assert.deepEqual(saved.selected, gray);
    if (red.length) {
      assert.equal(saved.finalDecision, "reject");
      assert.equal(saved.kimi, null);
    } else if (!gray.length) {
      assert.equal(saved.finalDecision, "accept");
      assert.equal(saved.kimi, null);
    } else if (saved.kimi?.status === "error")
      assert.equal(saved.finalDecision, "error");
    else {
      assert.ok(saved.kimi?.status === "success");
      const verdicts = gray.map((key) =>
        saved.kimi?.status === "success"
          ? saved.kimi.result.judgments[key]?.verdict
          : "error",
      );
      assert.equal(
        saved.finalDecision,
        verdicts.includes("fail")
          ? "reject"
          : verdicts.includes("uncertain")
            ? "uncertain"
            : "accept",
      );
    }
  } else {
    assert.equal(saved.finalDecision, "error");
    assert.equal(saved.risk, null);
    assert.equal(saved.kimi, null);
  }
}

/** Independent, offline audit: no API key, model invocation or storage mutation is used. */
export async function auditCandidateArtifacts(
  directory: string,
  options: {
    allowIncomplete?: boolean;
    filterProtocol?: string;
    generatorArchive?: string;
  } = {},
) {
  const protocol = await json<Protocol>(join(directory, "protocol.json"));
  assert.equal(protocol.policyHash, CANDIDATE_POLICY_HASH);
  assert.deepEqual(protocol.limits, CANDIDATE_RUN_LIMITS);
  const archivedSources: string[] = [];
  for (const [path, expected] of Object.entries(protocol.code)) {
    const current = await fileHash(path);
    if (
      current !== expected &&
      options.generatorArchive &&
      path === "lib/maintenance/consolidation-proposals.ts"
    ) {
      const manifest = await json<{ codeHashes: Record<string, string> }>(
        join(options.generatorArchive, "manifest.json"),
      );
      assert.equal(manifest.codeHashes[path], expected);
      assert.equal(
        await fileHash(join(options.generatorArchive, `${path}.txt`)),
        expected,
      );
      archivedSources.push(path);
    } else assert.equal(current, expected, `Frozen source changed: ${path}`);
  }
  let { pages } = await json<{ pages: BrainPage[] }>(
    join(directory, "input.json"),
  );
  assert.equal(hash(pages), protocol.initialHash);
  if (protocol.invariantHash)
    assert.equal(
      hash(await json(join(directory, "invariants.json"))),
      protocol.invariantHash,
    );
  const dependencyHashes = Object.fromEntries(
    await Promise.all(
      ["package.json", "pnpm-lock.yaml"].map(async (path) => [
        path,
        await fileHash(path),
      ]),
    ),
  );
  const filterPath =
    options.filterProtocol ??
    "artifacts/consolidation/release-v1/filter-validation/protocol.json";
  const filter = await json<{
    frozenAt: string;
    contract: { policyHash: string; codeHashes: Record<string, string> };
  }>(filterPath);
  assert.equal(filter.contract.policyHash, protocol.policyHash);
  for (const [path, actual] of Object.entries(dependencyHashes))
    assert.equal(
      actual,
      filter.contract.codeHashes[path],
      `Dependency differs from the prior filter freeze: ${path}`,
    );
  const history: CandidateHistoryEntry[] = [];
  const rows: {
    pass: number;
    proposed: number;
    applied: number;
    jevCalls: number;
    kimiCalls: number;
    unresolvedCalls: number;
    reportedCostUsd: number;
    unknownCostCalls: number;
    changed: boolean;
  }[] = [];
  let receiptsChecked = 0;
  for (let pass = 1; pass <= protocol.passes; pass++) {
    const passPath = join(directory, `pass-${String(pass).padStart(2, "0")}`);
    if (!(await exists(`${passPath}.json`))) {
      assert.ok(options.allowIncomplete, `Missing completed pass ${pass}.`);
      break;
    }
    const row = await json<Pass>(`${passPath}.json`);
    assert.equal(row.pass, pass);
    assert.equal(row.beforeHash, semanticHash(pages));
    assert.equal(
      row.result.report.mode,
      protocol.mode === "volume" ? "apply" : "preview",
    );
    assert.equal(
      row.result.report.persisted,
      false,
      "This runner must never persist Brain writes.",
    );
    assert.equal(row.result.report.policyHash, protocol.policyHash);
    assert.equal(
      row.changed,
      semanticHash(pages) !== semanticHash(row.result.pages),
    );
    assert.equal(row.afterHash, semanticHash(row.result.pages));
    const report = row.result.report;
    if (archivedSources.length) {
      assert.equal(
        report.entries.length,
        0,
        "Archived generator audit is limited to completed generation failures with no evaluated proposals.",
      );
      assert.equal(report.writes, 0);
      assert.ok(report.fault);
    }
    let costPico = 0,
      unknownCost = 0,
      unknownToken = 0,
      inputTokens = 0,
      outputTokens = 0;
    const account = (
      input: number | undefined | null,
      output: number | undefined | null,
      cost: number | undefined | null,
    ) => {
      inputTokens += input ?? 0;
      outputTokens += output ?? 0;
      if (cost == null) unknownCost++;
      else costPico += Math.round(cost * 1e12);
      if (input == null || output == null) unknownToken++;
    };
    const observedFiles = await readdir(passPath);
    const outcomes = new Set<string>();
    const started = new Set<string>();
    const receipt = async <T>(key: string, input: unknown): Promise<T> => {
      const saved = await json<Receipt<T>>(join(passPath, `${key}.json`));
      const beginning = await json<{ inputHash: string; startedAt: string }>(
        join(passPath, `${key}.started.json`),
      );
      assert.equal(
        saved.inputHash,
        hash(input),
        `Receipt input mismatch: pass ${pass} ${key}`,
      );
      assert.equal(beginning.inputHash, saved.inputHash);
      assert.ok(
        Date.parse(saved.finishedAt) >= Date.parse(beginning.startedAt),
      );
      outcomes.add(`${key}.json`);
      started.add(`${key}.started.json`);
      receiptsChecked++;
      return saved.outcome;
    };
    let generated: Generation | null = null;
    if (observedFiles.includes("generation.json")) {
      generated = await receipt<Generation>("generation", pages);
      assert.deepEqual(report.generation, {
        model: generated.model,
        usage: generated.usage,
        ...(generated.generationFault === undefined
          ? {}
          : { generationFault: generated.generationFault }),
        ...(generated.responseDiagnostics === undefined
          ? {}
          : { responseDiagnostics: generated.responseDiagnostics }),
      });
      assert.equal(report.proposed, generated.proposals.length);
      account(
        generated.usage.inputTokens,
        generated.usage.outputTokens,
        generated.usage.costUsd,
      );
      if (
        generated.usage.inputTokensReported === false ||
        generated.usage.outputTokensReported === false
      )
        unknownToken++;
      if (generated.generationFault) {
        assert.ok(report.fault);
        assert.equal(report.entries.length, 0);
      }
    } else {
      assert.ok(
        report.fault,
        "Unrecorded generation requires an explicit technical error.",
      );
      assert.equal(report.entries.length, 0);
      assert.equal(report.generation, null);
      const begin = await json<{ inputHash: string }>(
        join(passPath, "generation.started.json"),
      );
      assert.equal(begin.inputHash, hash(pages));
      started.add("generation.started.json");
      account(null, null, null);
    }
    let expectedPages = structuredClone(pages),
      evalIndex = 0,
      jevCalls = 0,
      kimiCalls = 0,
      unresolvedCalls = generated ? 0 : 1;
    let accepted = 0,
      applied = 0,
      cached = 0,
      invalid = generated?.rejectedProposals.length ?? 0;
    const newHistory: CandidateHistoryEntry[] = [];
    const targets = new Set<string>();
    for (const [position, entry] of report.entries.entries()) {
      assert.equal(
        entry.index,
        position,
        "Entries must follow proposal order without gaps.",
      );
      const proposal = generated?.proposals[entry.index];
      assert.ok(proposal);
      assert.equal(entry.pageId, proposal.pageId);
      assert.equal(entry.operation, proposal.operation);
      if (targets.has(entry.pageId)) {
        assert.equal(entry.decision, "duplicate_target");
        assert.equal(entry.application, "not_applied");
        invalid++;
        continue;
      }
      targets.add(entry.pageId);
      let prepared: ReturnType<typeof prepareCandidateProposal>;
      try {
        prepared = prepareCandidateProposal(pages, proposal);
      } catch {
        assert.equal(entry.decision, "invalid");
        assert.equal(entry.application, "not_applied");
        invalid++;
        continue;
      }
      assert.equal(entry.proposalFingerprint, prepared.proposalFingerprint);
      assert.equal(entry.evidenceFingerprint, prepared.evidenceFingerprint);
      assert.equal(entry.beforeVersion, prepared.beforePage.version);
      assert.deepEqual(entry.diff, {
        before: prepared.beforePage.markdown,
        after: prepared.nextPage.markdown,
      });
      assert.deepEqual(Object.keys(prepared.input).sort(), [
        "after",
        "before",
        "evidence",
        "operation",
      ]);
      const evidence = prepared.input.evidence as {
        sources: {
          pageId: string;
          version: number;
          title: string;
          summary: string;
          markdown: string;
          links: unknown;
        }[];
        citations: unknown;
      };
      assert.deepEqual(evidence.citations, proposal.evidence);
      assert.deepEqual(
        evidence.sources,
        pages.map((page) => ({
          pageId: page.id,
          version: page.version,
          title: page.title,
          summary: page.summary,
          markdown: page.markdown,
          links: page.links,
        })),
      );
      const prior = history.find(
        (item) =>
          item.policyHash === protocol.policyHash &&
          item.proposalFingerprint === prepared.proposalFingerprint &&
          item.evidenceFingerprint === prepared.evidenceFingerprint,
      );
      if (prior) {
        assert.equal(entry.decision, "cached");
        assert.equal(entry.application, "not_applied");
        assert.equal(entry.assessment, undefined);
        cached++;
        continue;
      }
      const key = `evaluation-${++evalIndex}`;
      if (!entry.assessment) {
        assert.equal(entry.decision, "error");
        assert.ok(report.fault);
        assert.equal(entry.application, "not_applied");
        const begin = await json<{ inputHash: string }>(
          join(passPath, `${key}.started.json`),
        );
        assert.equal(begin.inputHash, hash(prepared.input));
        started.add(`${key}.started.json`);
        account(null, null, null);
        unresolvedCalls++;
        continue;
      }
      const saved = await receipt<Evaluation>(key, prepared.input);
      await verifyEvaluation(prepared.input, saved);
      assert.deepEqual(entry.assessment, saved);
      assert.equal(entry.decision, saved.finalDecision);
      jevCalls++;
      if (saved.jev.status === "success")
        account(
          saved.jev.result.usage.inputTokens,
          saved.jev.result.usage.outputTokens,
          saved.jev.result.usage.gateway?.cost,
        );
      else account(null, null, null);
      if (saved.kimi) {
        kimiCalls++;
        const usage =
          saved.kimi.status === "success"
            ? saved.kimi.result.usage
            : saved.kimi.error.diagnostic?.usage;
        account(usage?.inputTokens, usage?.outputTokens, usage?.costUsd);
      }
      if (entry.decision === "accept") {
        accepted++;
        assert.equal(
          entry.application,
          protocol.mode === "volume" ? "applied" : "preview",
        );
        if (entry.application === "applied") {
          applied++;
          assert.equal(
            prepared.nextPage.version,
            prepared.beforePage.version + 1,
          );
          assert.equal(entry.writtenVersion, prepared.nextPage.version);
          expectedPages = expectedPages.map((page) =>
            page.id === prepared.nextPage.id ? prepared.nextPage : page,
          );
        }
      } else {
        assert.equal(entry.application, "not_applied");
        if (entry.decision === "reject" || entry.decision === "uncertain")
          newHistory.push({
            policyHash: protocol.policyHash,
            proposalFingerprint: prepared.proposalFingerprint,
            evidenceFingerprint: prepared.evidenceFingerprint,
            decision: entry.decision,
          });
      }
    }
    assert.deepEqual(
      observedFiles
        .filter(
          (name) => name.endsWith(".json") && !name.endsWith(".started.json"),
        )
        .sort(),
      [...outcomes].sort(),
      "Unaccounted model outcome receipt.",
    );
    assert.deepEqual(
      observedFiles.filter((name) => name.endsWith(".started.json")).sort(),
      [...started].sort(),
      "Unaccounted model request start.",
    );
    assert.deepEqual(
      row.result.pages,
      expectedPages,
      "A non-approved field/page changed, or an approved change was not applied exactly.",
    );
    assert.equal(report.accepted, accepted);
    assert.equal(report.writes, applied);
    assert.equal(report.cached, cached);
    assert.equal(report.invalid, invalid);
    assert.equal(
      report.evaluated,
      report.entries.filter((entry) => entry.assessment).length,
    );
    assert.ok(
      report.proposed <= protocol.limits.proposals &&
        accepted <= protocol.limits.writes,
    );
    assert.deepEqual(report.history, newHistory);
    assert.equal(report.inputTokens, inputTokens);
    assert.equal(report.outputTokens, outputTokens);
    assert.equal(report.reportedCostUsd, costPico / 1e12);
    assert.equal(report.unknownCostCalls, unknownCost);
    assert.equal(report.unknownTokenCalls, unknownToken);
    if (report.entries.length < report.proposed)
      assert.ok(report.budgetReached || report.fault);
    rows.push({
      pass,
      proposed: report.proposed,
      applied,
      jevCalls,
      kimiCalls,
      unresolvedCalls,
      reportedCostUsd: costPico / 1e12,
      unknownCostCalls: unknownCost,
      changed: row.changed,
    });
    pages = row.result.pages;
    history.push(...newHistory);
  }
  const unfinishedRequests: {
    pass: number;
    key: string;
    inputHash: string;
    startedAt: string;
    hasOutcome: boolean;
  }[] = [];
  if (rows.length < protocol.passes) {
    const pendingPass = rows.length + 1;
    const pendingPath = join(
      directory,
      `pass-${String(pendingPass).padStart(2, "0")}`,
    );
    let pendingFiles: string[] = [];
    try {
      pendingFiles = await readdir(pendingPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const file of pendingFiles.filter((name) =>
      name.endsWith(".started.json"),
    )) {
      const start = await json<{ inputHash: string; startedAt: string }>(
        join(pendingPath, file),
      );
      const key = file.slice(0, -".started.json".length);
      if (key === "generation") assert.equal(start.inputHash, hash(pages));
      unfinishedRequests.push({
        pass: pendingPass,
        key,
        ...start,
        hasOutcome: pendingFiles.includes(`${key}.json`),
      });
    }
  } else {
    const summary = await json<{
      passes: number;
      appliedToCopy: number;
      reportedCostUsd: number;
      unknownCostCalls: number;
      finalSemanticHash: string;
    }>(join(directory, "summary.json"));
    assert.equal(summary.passes, rows.length);
    assert.equal(
      summary.appliedToCopy,
      rows.reduce((sum, row) => sum + row.applied, 0),
    );
    assert.equal(
      summary.reportedCostUsd,
      rows.reduce(
        (sum, row) => sum + Math.round(row.reportedCostUsd * 1e12),
        0,
      ) / 1e12,
    );
    assert.equal(
      summary.unknownCostCalls,
      rows.reduce((sum, row) => sum + row.unknownCostCalls, 0),
    );
    assert.equal(summary.finalSemanticHash, semanticHash(pages));
  }
  return {
    version: 1,
    complete: rows.length === protocol.passes,
    requestedPasses: protocol.passes,
    checkedPasses: rows.length,
    receiptsChecked,
    policyHash: protocol.policyHash,
    protocolHash: await fileHash(join(directory, "protocol.json")),
    dependencyHashes,
    archivedSources,
    dependencyReference: {
      path: filterPath,
      frozenAt: filter.frozenAt,
      hash: await fileHash(filterPath),
    },
    finalSemanticHash: semanticHash(pages),
    unfinishedRequests,
    rows,
    notes: [
      "Offline structural and policy audit; semantic quality and opportunity exhaustion require the separate source audit.",
      "A composed evaluation receipt can cover Jev plus Kimi; unresolved interrupted calls have unknown billing/count.",
      "Dependency hashes match the earlier filter protocol; the volume protocol itself did not freeze those package files.",
    ],
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      output: { type: "string" },
      "allow-incomplete": { type: "boolean", default: false },
      "filter-protocol": { type: "string" },
      "generator-archive": { type: "string" },
    },
  });
  if (!values.input)
    throw new Error(
      "Use --input candidate-run-directory [--output audit.json] [--allow-incomplete].",
    );
  const input = resolve(values.input);
  const result = await auditCandidateArtifacts(input, {
    allowIncomplete: values["allow-incomplete"],
    filterProtocol: values["filter-protocol"],
    generatorArchive: values["generator-archive"],
  });
  const output = resolve(
    values.output ?? join(input, "independent-audit.json"),
  );
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      audited: true,
      complete: result.complete,
      passes: result.checkedPasses,
      receipts: result.receiptsChecked,
      output,
    }),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Offline audit failed.",
    );
    process.exitCode = 1;
  });
