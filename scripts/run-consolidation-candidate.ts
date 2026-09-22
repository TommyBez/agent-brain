import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadEnvConfig } from "@next/env";
import type { BrainPage } from "../lib/brain/types";
import {
  CANDIDATE_POLICY_HASH,
  evaluateCandidate,
} from "../lib/maintenance/consolidation-candidate";
import { proposeConsolidation } from "../lib/maintenance/consolidation-proposals";
import {
  CANDIDATE_RUN_LIMITS,
  type CandidateHistoryEntry,
  runConsolidationSnapshot,
} from "../lib/maintenance/consolidation-run";

const files = [
  "lib/maintenance/consolidation-run.ts",
  "lib/maintenance/consolidation-candidate.ts",
  "lib/maintenance/consolidation-proposals.ts",
  "lib/maintenance/consolidation-defect-questions.ts",
  "lib/maintenance/consolidation-rubric.ts",
  "lib/maintenance/jev.ts",
  "lib/maintenance/kimi-evaluator.ts",
  "lib/maintenance/kimi-source-contract.ts",
  "lib/maintenance/gateway.ts",
  "scripts/run-consolidation-candidate.ts",
];
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fileHash = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const json = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8"));
const save = (path: string, value: unknown) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
async function exists(path: string) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function codeHashes() {
  return Object.fromEntries(
    await Promise.all(files.map(async (path) => [path, await fileHash(path)])),
  );
}

/** Ignore revision clocks for convergence, preserve every knowledge-bearing field. */
export function semanticHash(pages: BrainPage[]) {
  return hash(
    pages
      .map(
        ({
          id,
          slug,
          type,
          title,
          summary,
          markdown,
          aliases,
          tags,
          links,
        }) => ({
          id,
          slug,
          type,
          title,
          summary,
          markdown,
          aliases,
          tags,
          links: links
            .map(({ targetId, type: edgeType, label }) => ({
              targetId,
              type: edgeType,
              label,
            }))
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        }),
      )
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

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

/** Receipts are per physical operation. An unanswered started request is never silently retried. */
async function receipt<T>(
  directory: string,
  key: string,
  input: unknown,
  call: () => Promise<T>,
): Promise<T> {
  const path = join(directory, key);
  const inputHash = hash(input);
  if (await exists(`${path}.json`)) {
    const saved = await json<{ inputHash: string; outcome: T }>(`${path}.json`);
    assert.equal(saved.inputHash, inputHash, "Receipt input changed.");
    return saved.outcome;
  }
  if (await exists(`${path}.started.json`))
    throw new Error(`Unanswered request ${key}: do not auto-retry.`);
  await save(`${path}.started.json`, {
    startedAt: new Date().toISOString(),
    inputHash,
  });
  const outcome = await call();
  await save(`${path}.json`, {
    inputHash,
    finishedAt: new Date().toISOString(),
    outcome,
  });
  return outcome;
}

async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: "string" },
      output: { type: "string" },
      snapshot: { type: "string" },
      invariants: { type: "string" },
      preview: { type: "boolean", default: false },
    },
  });
  if (
    !values.output ||
    !["prepare", "run", "verify"].includes(values.mode ?? "")
  )
    throw new Error(
      "Use --mode prepare|run|verify --output private-path; prepare also requires --snapshot.",
    );
  const output = resolve(values.output);
  const protocolPath = join(output, "protocol.json");
  if (values.mode === "prepare") {
    if (!values.snapshot) throw new Error("Missing complete snapshot.");
    const snapshot = await json<{ pages: BrainPage[] }>(
      resolve(values.snapshot),
    );
    assert.ok(snapshot.pages.length > 0);
    if (!values.preview && !values.invariants)
      throw new Error(
        "Freeze invariants and opportunities before the volume run.",
      );
    const invariants = values.invariants
      ? await json<unknown>(resolve(values.invariants))
      : null;
    await mkdir(output, { recursive: true });
    await save(join(output, "input.json"), snapshot);
    if (invariants) await save(join(output, "invariants.json"), invariants);
    const protocol: Protocol = {
      preparedAt: new Date().toISOString(),
      mode: values.preview ? "preview" : "volume",
      passes: values.preview ? 1 : 20,
      initialHash: hash(snapshot.pages),
      invariantHash: invariants ? hash(invariants) : null,
      code: await codeHashes(),
      policyHash: CANDIDATE_POLICY_HASH,
      limits: CANDIDATE_RUN_LIMITS,
    };
    await save(protocolPath, protocol);
    console.log(
      JSON.stringify({
        prepared: true,
        passes: protocol.passes,
        initialHash: protocol.initialHash,
      }),
    );
    return;
  }
  const protocol = await json<Protocol>(protocolPath);
  assert.deepEqual(
    await codeHashes(),
    protocol.code,
    "Frozen candidate code changed; preserve old run and prepare a new version.",
  );
  assert.equal(protocol.policyHash, CANDIDATE_POLICY_HASH);
  let { pages } = await json<{ pages: BrainPage[] }>(
    join(output, "input.json"),
  );
  assert.equal(hash(pages), protocol.initialHash);
  if (protocol.invariantHash)
    assert.equal(
      hash(await json(join(output, "invariants.json"))),
      protocol.invariantHash,
    );
  let history: CandidateHistoryEntry[] = [];
  const rows: Pass[] = [];
  if (values.mode === "run") loadEnvConfig(process.cwd());
  for (let pass = 1; pass <= protocol.passes; pass++) {
    const passPath = join(output, `pass-${String(pass).padStart(2, "0")}`);
    let row: Pass;
    if (await exists(`${passPath}.json`))
      row = await json<Pass>(`${passPath}.json`);
    else {
      if (values.mode === "verify") throw new Error(`Missing pass ${pass}.`);
      await mkdir(passPath, { recursive: true });
      const startedAt = new Date().toISOString();
      let evalIndex = 0;
      const result = await runConsolidationSnapshot(
        pages,
        {
          mode: protocol.mode === "preview" ? "preview" : "apply",
          maxWrites: protocol.limits.writes,
          history,
        },
        {
          generate: (snapshot) =>
            receipt(passPath, "generation", snapshot, () =>
              proposeConsolidation(snapshot, { scope: "candidate-v1" }),
            ),
          evaluate: (input) =>
            receipt(passPath, `evaluation-${++evalIndex}`, input, () =>
              evaluateCandidate(input),
            ),
        },
      );
      row = {
        pass,
        startedAt,
        finishedAt: new Date().toISOString(),
        elapsedMs: Date.now() - Date.parse(startedAt),
        beforeHash: semanticHash(pages),
        afterHash: semanticHash(result.pages),
        changed: semanticHash(pages) !== semanticHash(result.pages),
        result,
      };
      await save(`${passPath}.json`, row);
      console.log(
        JSON.stringify({
          pass,
          proposed: result.report.proposed,
          accepted: result.report.accepted,
          appliedToCopy: result.report.writes,
          changed: row.changed,
          error: result.report.fault,
          costUsd: result.report.reportedCostUsd,
          unknownCostCalls: result.report.unknownCostCalls,
          elapsedMs: row.elapsedMs,
        }),
      );
    }
    assert.equal(
      row.beforeHash,
      semanticHash(pages),
      "Sequential input does not match previous output.",
    );
    assert.equal(row.afterHash, semanticHash(row.result.pages));
    assert.equal(row.result.report.policyHash, protocol.policyHash);
    const generationPath = join(passPath, "generation.json");
    if (await exists(generationPath)) {
      const generation = await json<{
        inputHash: string;
        outcome: Awaited<ReturnType<typeof proposeConsolidation>>;
      }>(generationPath);
      assert.equal(generation.inputHash, hash(pages));
      assert.deepEqual(
        row.result.report.generation?.usage,
        generation.outcome.usage,
      );
      assert.equal(
        row.result.report.proposed,
        generation.outcome.proposals.length,
      );
    } else
      assert.ok(
        row.result.report.fault,
        "Missing generation receipt without technical fault.",
      );
    let evaluationIndex = 0;
    for (const entry of row.result.report.entries) {
      if (!entry.assessment) continue;
      const receipt = await json<{
        outcome: Awaited<ReturnType<typeof evaluateCandidate>>;
      }>(join(passPath, `evaluation-${++evaluationIndex}.json`));
      assert.deepEqual(entry.assessment, receipt.outcome);
      assert.equal(entry.decision, receipt.outcome.finalDecision);
      if (entry.application === "applied") {
        assert.equal(entry.decision, "accept");
        assert.equal(
          row.result.pages.find((p) => p.id === entry.pageId)?.markdown,
          entry.diff?.after,
        );
      }
    }
    assert.equal(
      row.result.report.accepted,
      row.result.report.entries.filter((entry) => entry.decision === "accept")
        .length,
    );
    assert.equal(
      row.result.report.writes,
      row.result.report.entries.filter(
        (entry) => entry.application === "applied",
      ).length,
    );
    rows.push(row);
    pages = row.result.pages;
    history = [...history, ...row.result.report.history];
  }
  const summary = {
    mode: protocol.mode,
    passes: rows.length,
    appliedToCopy: rows.reduce((n, r) => n + r.result.report.writes, 0),
    accepted: rows.reduce((n, r) => n + r.result.report.accepted, 0),
    proposed: rows.reduce((n, r) => n + r.result.report.proposed, 0),
    errors: rows.filter((r) => r.result.report.fault !== null).length,
    unchangedTail:
      [...rows].reverse().findIndex((r) => r.changed) === -1
        ? rows.length
        : [...rows].reverse().findIndex((r) => r.changed),
    reportedCostUsd:
      rows.reduce(
        (n, r) => n + Math.round(r.result.report.reportedCostUsd * 1e12),
        0,
      ) / 1e12,
    unknownCostCalls: rows.reduce(
      (n, r) => n + r.result.report.unknownCostCalls,
      0,
    ),
    elapsedMs: rows.reduce((n, r) => n + r.elapsedMs, 0),
    initialHash: protocol.initialHash,
    finalSemanticHash: semanticHash(pages),
    note: "Sequential copies only. Stability alone does not demonstrate utility or exhaustion of the frozen opportunities; independent audit is separate.",
  };
  if (values.mode === "verify")
    assert.deepEqual(await json(join(output, "summary.json")), summary);
  else if (!(await exists(join(output, "summary.json"))))
    await save(join(output, "summary.json"), summary);
  console.log(
    JSON.stringify({ verified: values.mode === "verify", ...summary }),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch(() => {
    console.error(
      "Candidate run stopped. Inspect private immutable receipts; no production writes are reachable.",
    );
    process.exitCode = 1;
  });
