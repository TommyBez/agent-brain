import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadEnvConfig } from "@next/env";
import {
  CONSOLIDATION_CRITERIA,
  type ConsolidationCriterion,
} from "../lib/maintenance/consolidation-rubric";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import type { ConsolidationEvaluationInput } from "../lib/maintenance/jev";
import {
  KIMI_EVALUATOR_SETTINGS,
  KimiResponseError,
} from "../lib/maintenance/kimi-evaluator";
import {
  evaluateWithKimiSourceContract,
  KIMI_SOURCE_CONTRACT_ARMS,
  KIMI_SOURCE_CONTRACT_CLARIFICATION,
  type KimiSourceContractArm,
} from "../lib/maintenance/kimi-source-contract";
import { evaluateFixedCase } from "./evaluate-filter-contract";

// Offline experiment only: no generator, Jev call, database or production write.
const root = process.cwd();
const dataset = join(root, "artifacts/consolidation/jev-kimi-fixed-v1");
const prior = join(dataset, "run-source-choice-v1");
const SOURCE = "supported_by_evidence";
type Arm = KimiSourceContractArm;
type Criterion = ConsolidationCriterion;
type Evaluation = Awaited<ReturnType<typeof evaluateFixedCase>>;
type Outcome = NonNullable<Evaluation["kimi"]>;
type SafeError = Extract<Outcome, { status: "error" }>["error"];
type FrozenRow = Evaluation & {
  caseId: string;
  inputHash: string;
  label: string;
  arm: string;
  expectedDecision: string;
  expectedCriteria: Partial<Record<Criterion, { verdict: "pass" | "fail" }>>;
  kimiReceipt: string | null;
};
type Probe = {
  caseId: string;
  inputHash: string;
  input: ConsolidationEvaluationInput;
  selected: Criterion[];
  cohort: "existing" | "new";
  category: string;
  pairId: string | null;
  expectedVerdict: "pass" | "fail";
  rationale: string;
  label: string;
};
type ProbeRow = Omit<Probe, "input"> & {
  arm: Arm;
  outcome: Outcome;
  verdict: "pass" | "fail" | "uncertain" | "error";
};
type FixtureCase = {
  caseId: string;
  pairId: string;
  category: string;
  expectedVerdict: "pass" | "fail";
  rationale: string;
  contrastWith: string;
  inputHash: string;
  input: ConsolidationEvaluationInput;
  proof: { location: "before" | "after" | "evidence"; quote: string }[];
};
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const money = (values: number[]) =>
  Number(
    values.reduce(
      (sum, value) => sum + BigInt(Math.round(value * 1e12)),
      BigInt(0),
    ),
  ) / 1e12;
async function optional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function immutable(path: string, value: unknown) {
  const next = json(value),
    old = await optional(path);
  if (old !== undefined)
    assert.equal(old, next, `Frozen artifact changed: ${path}`);
  else await writeFile(path, next, { flag: "wx", mode: 0o600 });
}
function safeError(error: unknown): SafeError {
  if (error instanceof KimiResponseError)
    return {
      kind: "invalid_response",
      status: error.status,
      diagnostic: {
        stage: error.stage,
        reasonCode: error.reasonCode,
        usage: error.usage,
        responseId: error.responseId,
        responseModel: error.responseModel,
        latencyMs: error.latencyMs,
      },
    };
  if (error instanceof GatewayRequestError)
    return {
      kind: error.status === null ? "transport_or_configuration" : "http",
      status: error.status,
    };
  return { kind: "unexpected", status: null };
}
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object")
    return Object.values(value).flatMap(strings);
  return [];
}
function summarize(rows: ProbeRow[]) {
  const count = (test: (row: ProbeRow) => boolean) => rows.filter(test).length;
  return {
    total: rows.length,
    expectedPass: count((row) => row.expectedVerdict === "pass"),
    expectedFail: count((row) => row.expectedVerdict === "fail"),
    correct: count((row) => row.verdict === row.expectedVerdict),
    correctPass: count(
      (row) => row.expectedVerdict === "pass" && row.verdict === "pass",
    ),
    correctFail: count(
      (row) => row.expectedVerdict === "fail" && row.verdict === "fail",
    ),
    falsePass: count(
      (row) => row.expectedVerdict === "fail" && row.verdict === "pass",
    ),
    falseFail: count(
      (row) => row.expectedVerdict === "pass" && row.verdict === "fail",
    ),
    uncertain: count((row) => row.verdict === "uncertain"),
    errors: count((row) => row.verdict === "error"),
  };
}
function cascadeSummary(rows: (Evaluation & { expectedDecision: string })[]) {
  const count = (test: (row: (typeof rows)[number]) => boolean) =>
    rows.filter(test).length;
  return {
    total: rows.length,
    correct: count((row) => row.finalDecision === row.expectedDecision),
    falseAccept: count(
      (row) =>
        row.expectedDecision === "reject" && row.finalDecision === "accept",
    ),
    falseReject: count(
      (row) =>
        row.expectedDecision === "accept" && row.finalDecision === "reject",
    ),
    uncertain: count((row) => row.finalDecision === "uncertain"),
    errors: count((row) => row.finalDecision === "error"),
    kimiRequestsInFrozenRoute: count((row) => row.selected.length > 0),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      mode: { type: "string", default: "prepare" },
    },
  });
  assert.ok(
    values.output && ["prepare", "run", "verify"].includes(values.mode),
    "Use --output <path> --mode prepare|run|verify",
  );
  const output = resolve(values.output),
    hashes: Record<string, string> = {};
  async function tracked(path: string) {
    const text = await readFile(path, "utf8");
    hashes[path.slice(root.length + 1)] = hash(text);
    return text;
  }
  const previousProtocolText = await tracked(join(prior, "protocol.json"));
  const previousProtocol = JSON.parse(previousProtocolText);
  const previous = JSON.parse(await tracked(join(prior, "results.json"))) as {
    protocolHash: string;
    cases: FrozenRow[];
  };
  assert.equal(previous.protocolHash, hash(previousProtocolText));
  const oldRows = previous.cases.filter((row) => row.arm === "binary");
  assert.equal(oldRows.length, 24);
  const inputText = await tracked(join(dataset, "inputs.json"));
  const referenceText = await tracked(join(dataset, "reference.json"));
  assert.equal(
    hash(inputText),
    previousProtocol.contract.hashes["dataset/inputs.json"],
  );
  assert.equal(
    hash(referenceText),
    previousProtocol.contract.hashes["dataset/reference.json"],
  );
  const inputs = JSON.parse(inputText) as {
    cases: {
      caseId: string;
      inputHash: string;
      input: ConsolidationEvaluationInput;
    }[];
  };
  const references = JSON.parse(referenceText) as {
    cases: {
      caseId: string;
      expectedDecision: string;
      expectedCriteria: FrozenRow["expectedCriteria"];
      rationale: string;
      label: string;
    }[];
  };
  for (const old of oldRows) {
    const ref = references.cases.find((row) => row.caseId === old.caseId);
    assert.ok(ref);
    assert.equal(old.expectedDecision, ref.expectedDecision);
    assert.deepEqual(old.expectedCriteria, ref.expectedCriteria);
    const receipt = JSON.parse(
      await tracked(join(prior, "receipts", `${old.caseId}-jev-binary.json`)),
    );
    assert.equal(receipt.identity.protocolHash, previous.protocolHash);
    assert.equal(receipt.identity.inputHash, old.inputHash);
    assert.equal(receipt.outcomeHash, hash(json(receipt.outcome)));
    assert.equal(receipt.outcome.status, "success");
    assert.equal(
      old.risk?.[SOURCE],
      Number(receipt.outcome.result.risk.toFixed(12)),
    );
    const historical = JSON.parse(
      await tracked(
        join(dataset, "run-defect-sdk-v2/receipts", `${old.caseId}-jev.json`),
      ),
    );
    assert.equal(historical.outcomeHash, hash(json(historical.outcome)));
    for (const key of CONSOLIDATION_CRITERIA.filter((key) => key !== SOURCE))
      assert.equal(old.risk?.[key], historical.outcome.result.answers[key]);
    if (old.kimiReceipt) {
      const kimi = JSON.parse(
        await tracked(join(prior, "receipts", old.kimiReceipt)),
      );
      assert.equal(kimi.outcomeHash, hash(json(kimi.outcome)));
      assert.deepEqual(kimi.outcome, old.kimi);
      assert.deepEqual(kimi.identity.selected, old.selected);
      assert.equal(kimi.identity.inputHash, old.inputHash);
    }
  }
  const freshFixture = JSON.parse(
    await tracked(join(root, "scripts/fixtures/kimi-source-contract-v1.json")),
  ) as { cases: FixtureCase[] };
  assert.equal(freshFixture.cases.length, 12);
  assert.equal(
    freshFixture.cases.filter((row) => row.expectedVerdict === "pass").length,
    6,
  );
  assert.equal(new Set(freshFixture.cases.map((row) => row.pairId)).size, 6);
  for (const item of freshFixture.cases) {
    assert.equal(item.inputHash, hash(JSON.stringify(item.input)));
    assert.deepEqual(Object.keys(item.input).sort(), [
      "after",
      "before",
      "evidence",
      "operation",
    ]);
    for (const proof of item.proof)
      assert.ok(
        proof.quote &&
          strings(item.input[proof.location]).some((text) =>
            text.includes(proof.quote),
          ),
        `Missing proof: ${item.caseId}`,
      );
    const pair = freshFixture.cases.find(
      (row) => row.caseId === item.contrastWith,
    );
    assert.ok(pair);
    assert.equal(pair.contrastWith, item.caseId);
    assert.equal(pair.pairId, item.pairId);
    assert.notEqual(pair.expectedVerdict, item.expectedVerdict);
    assert.deepEqual(item.input.before, pair.input.before);
    assert.deepEqual(item.input.evidence, pair.input.evidence);
  }
  const probes: Probe[] = oldRows
    .filter((row) => row.expectedCriteria[SOURCE])
    .map((row) => {
      const item = inputs.cases.find((item) => item.caseId === row.caseId);
      assert.ok(item);
      const ref = references.cases.find((item) => item.caseId === row.caseId);
      assert.ok(ref);
      const expected = row.expectedCriteria[SOURCE];
      assert.ok(expected);
      assert.equal(hash(JSON.stringify(item.input)), row.inputHash);
      return {
        caseId: row.caseId,
        inputHash: item.inputHash,
        input: item.input,
        selected: row.selected.includes(SOURCE) ? row.selected : [SOURCE],
        cohort: "existing",
        category: "existing",
        pairId: null,
        expectedVerdict: expected.verdict,
        rationale: ref.rationale,
        label: row.label,
      };
    });
  assert.equal(probes.length, 14);
  for (const item of freshFixture.cases)
    probes.push({
      caseId: item.caseId,
      inputHash: item.inputHash,
      input: item.input,
      selected: [SOURCE],
      cohort: "new",
      category: item.category,
      pairId: item.pairId,
      expectedVerdict: item.expectedVerdict,
      rationale: item.rationale,
      label: `${item.pairId} / ${item.category}`,
    });
  assert.equal(new Set(probes.map((row) => row.inputHash)).size, 26);
  const codeFiles = [
    "scripts/evaluate-kimi-source-contract.ts",
    "lib/maintenance/kimi-source-contract.ts",
    "lib/maintenance/kimi-evaluator.ts",
    "lib/maintenance/gateway.ts",
    "lib/maintenance/consolidation-rubric.ts",
    "lib/maintenance/defect-threshold-method.ts",
    "scripts/evaluate-filter-contract.ts",
    "package.json",
    "pnpm-lock.yaml",
  ];
  const codeHashes: Record<string, string> = {};
  for (const path of codeFiles)
    codeHashes[path] = hash(await readFile(join(root, path)));
  for (const path of [
    "lib/maintenance/kimi-evaluator.ts",
    "lib/maintenance/consolidation-rubric.ts",
    "scripts/evaluate-filter-contract.ts",
  ])
    assert.equal(codeHashes[path], previousProtocol.contract.codeHashes[path]);
  const contract = {
    version: 1,
    hashes,
    codeHashes,
    settings: KIMI_EVALUATOR_SETTINGS,
    clarification: KIMI_SOURCE_CONTRACT_CLARIFICATION,
    bands: previousProtocol.contract.bands,
    calls: 52,
    cases: 26,
    arms: KIMI_SOURCE_CONTRACT_ARMS,
    repetitions: 1,
    maxAttemptsPerJob: 1,
    concurrency: 3,
    design:
      "Paired fresh Kimi baseline/clarified on 14 existing explicitly labeled source cases and 12 new paired cases. Alternating arm order by case index. Same input and selected criteria in each pair. Only Q02/Q21 preserve actual three-criterion delegations; remaining24 source-only calls are targeted diagnostics, not production routing.",
    reconstruction:
      "No Jev calls or threshold changes. Frozen 24-case binary routing from run-source-choice-v1. Replace Q02/Q21 Kimi receipts with matching fresh arm outputs for all selected criteria; reuse eight unaffected historical Kimi receipts equally in both arms. This is a controlled reconstructed cascade, not a fully fresh end-to-end run.",
    primary:
      "Compare pass/fail correctness, unsupported facts wrongly passed or left uncertain, and legitimate rewrites wrongly rejected, separately for existing and new cohorts. Labels are fixed before model calls, never model-generated verdicts.",
    successRule:
      "Clarified must fail Q02, improve source correctness over fresh baseline, introduce no new wrong source or labeled downstream criterion decisions, not reduce new-cohort correctness or correct positive judgments in either cohort or reconstructed cascade correctness, and have no technical errors. No post-response edits or threshold fitting. This pilot does not authorize production promotion.",
    limitations:
      "One call per case/arm, correlated paired scenarios, no expected-uncertain controls; cannot establish correct handling of genuine evidence ambiguity or population reliability.",
    money:
      "Sum provider-reported USD costs using integer units of 1e-12 USD, separately flag missing costs. No historical reused receipt charges counted in current run.",
  };
  await mkdir(output, { recursive: true, mode: 0o700 });
  const lock = join(output, ".lock");
  await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  try {
    const oldProtocol = await optional(join(output, "protocol.json"));
    if (values.mode !== "prepare")
      assert.ok(oldProtocol, "Prepare/freeze before model calls");
    const protocol = oldProtocol
      ? JSON.parse(oldProtocol)
      : { frozenAt: new Date().toISOString(), contract };
    assert.deepEqual(protocol.contract, contract, "Frozen experiment changed");
    await immutable(join(output, "protocol.json"), protocol);
    await immutable(join(output, "inputs.json"), {
      cases: probes.map(({ caseId, inputHash, input, selected }) => ({
        caseId,
        inputHash,
        input,
        selected,
      })),
    });
    await immutable(join(output, "reference.json"), {
      cases: probes.map(({ input: _input, ...ref }) => ref),
    });
    if (values.mode === "prepare") {
      console.log(
        json({ status: "prepared", calls: 52, oldCases: 14, newCases: 12 }),
      );
      return;
    }
    if (values.mode === "run") {
      loadEnvConfig(root);
      assert.ok(
        process.env.AI_GATEWAY_API_KEY?.trim(),
        "AI Gateway key not available",
      );
    }
    const protocolHash = hash(json(protocol)),
      receiptDir = join(output, "receipts");
    await mkdir(receiptDir, { recursive: true, mode: 0o700 });
    async function evaluate(item: Probe, arm: Arm): Promise<Outcome> {
      const identity = {
        protocolHash,
        caseId: item.caseId,
        inputHash: item.inputHash,
        selected: item.selected,
        arm,
      };
      const path = join(receiptDir, `${item.caseId}-${arm}.json`),
        saved = await optional(path);
      if (saved) {
        const receipt = JSON.parse(saved);
        assert.deepEqual(receipt.identity, identity);
        assert.equal(receipt.outcomeHash, hash(json(receipt.outcome)));
        assert.deepEqual(
          JSON.parse((await optional(`${path}.started`)) ?? "null"),
          { identity, startedAt: receipt.startedAt },
        );
        return receipt.outcome;
      }
      assert.notEqual(
        values.mode,
        "verify",
        `Missing receipt ${item.caseId}/${arm}`,
      );
      assert.equal(
        await optional(`${path}.started`),
        undefined,
        "Unknown prior provider outcome; do not retry",
      );
      const startedAt = new Date().toISOString();
      await immutable(`${path}.started`, { identity, startedAt });
      let outcome: Outcome;
      try {
        outcome = {
          status: "success",
          result: await evaluateWithKimiSourceContract(
            item.input,
            item.selected,
            arm,
          ),
        };
      } catch (error) {
        outcome = { status: "error", error: safeError(error) };
      }
      await immutable(path, {
        identity,
        startedAt,
        endedAt: new Date().toISOString(),
        outcome,
        outcomeHash: hash(json(outcome)),
      });
      return outcome;
    }
    let next = 0,
      completed = 0;
    const rows: ProbeRow[] = [];
    const work = await Promise.allSettled(
      Array.from({ length: 3 }, async () => {
        while (next < probes.length) {
          const index = next++,
            item = probes[index];
          for (const arm of index % 2
            ? [...KIMI_SOURCE_CONTRACT_ARMS].reverse()
            : KIMI_SOURCE_CONTRACT_ARMS) {
            const outcome = await evaluate(item, arm),
              { input: _input, ...reference } = item;
            const verdict =
              outcome.status === "success"
                ? (outcome.result.judgments[SOURCE]?.verdict ?? "error")
                : "error";
            rows.push({ ...reference, arm, outcome, verdict });
            console.log(
              json({
                completed: ++completed,
                total: 52,
                caseId: item.caseId,
                arm,
                status: outcome.status,
              }).trim(),
            );
          }
        }
      }),
    );
    for (const result of work)
      if (result.status === "rejected") throw result.reason;
    rows.sort(
      (a, b) => a.caseId.localeCompare(b.caseId) || a.arm.localeCompare(b.arm),
    );
    const summaries = Object.fromEntries(
      KIMI_SOURCE_CONTRACT_ARMS.map((arm) => [
        arm,
        {
          overall: summarize(rows.filter((row) => row.arm === arm)),
          existing: summarize(
            rows.filter((row) => row.arm === arm && row.cohort === "existing"),
          ),
          new: summarize(
            rows.filter((row) => row.arm === arm && row.cohort === "new"),
          ),
          byCategory: Object.fromEntries(
            [...new Set(probes.map((row) => row.category))].map((category) => [
              category,
              summarize(
                rows.filter(
                  (row) => row.arm === arm && row.category === category,
                ),
              ),
            ]),
          ),
        },
      ]),
    ) as Record<
      Arm,
      {
        overall: ReturnType<typeof summarize>;
        existing: ReturnType<typeof summarize>;
        new: ReturnType<typeof summarize>;
        byCategory: Record<string, ReturnType<typeof summarize>>;
      }
    >;
    const cascades: (Evaluation & {
      caseId: string;
      arm: Arm;
      expectedDecision: string;
      expectedCriteria: FrozenRow["expectedCriteria"];
      refreshedKimi: boolean;
    })[] = [];
    for (const arm of KIMI_SOURCE_CONTRACT_ARMS)
      for (const old of oldRows) {
        const input = inputs.cases.find((row) => row.caseId === old.caseId);
        assert.ok(input);
        const refreshedKimi = old.selected.includes(SOURCE);
        const result = await evaluateFixedCase(input.input, contract.bands, {
          jev: async () => old.jev,
          kimi: async (clean, selected) => {
            assert.equal(hash(JSON.stringify(clean)), input.inputHash);
            assert.deepEqual(selected, old.selected);
            if (refreshedKimi) {
              const row = rows.find(
                (row) => row.caseId === old.caseId && row.arm === arm,
              );
              assert.ok(row);
              assert.deepEqual(row.selected, selected);
              return row.outcome;
            }
            assert.ok(old.kimi);
            return old.kimi;
          },
        });
        assert.deepEqual(result.risk, old.risk);
        assert.deepEqual(result.selected, old.selected);
        cascades.push({
          ...result,
          caseId: old.caseId,
          arm,
          expectedDecision: old.expectedDecision,
          expectedCriteria: old.expectedCriteria,
          refreshedKimi,
        });
      }
    const cascadeSummaries = Object.fromEntries(
      KIMI_SOURCE_CONTRACT_ARMS.map((arm) => [
        arm,
        cascadeSummary(cascades.filter((row) => row.arm === arm)),
      ]),
    );
    const costs = rows.map((row) => ({
      caseId: row.caseId,
      arm: row.arm,
      cost:
        row.outcome.status === "success"
          ? row.outcome.result.usage.costUsd
          : (row.outcome.error.diagnostic?.usage.costUsd ?? null),
    }));
    const billing = {
      actualCalls: costs.length,
      totalReportedUsd: money(
        costs.flatMap((row) => (row.cost === null ? [] : [row.cost])),
      ),
      perArm: Object.fromEntries(
        KIMI_SOURCE_CONTRACT_ARMS.map((arm) => [
          arm,
          money(
            costs
              .filter((row) => row.arm === arm)
              .flatMap((row) => (row.cost === null ? [] : [row.cost])),
          ),
        ]),
      ),
      missingCosts: costs
        .filter((row) => row.cost === null)
        .map((row) => `${row.caseId}/${row.arm}`),
    };
    const newWrongSource = rows
      .filter(
        (row) =>
          row.arm === "clarified" &&
          ["pass", "fail"].includes(row.verdict) &&
          row.verdict !== row.expectedVerdict &&
          rows.find(
            (other) => other.caseId === row.caseId && other.arm === "baseline",
          )?.verdict !== row.verdict,
      )
      .map((row) => row.caseId);
    const newWrongDownstream: string[] = [];
    for (const row of cascades.filter((row) => row.arm === "clarified"))
      for (const key of CONSOLIDATION_CRITERIA) {
        const expected = row.expectedCriteria[key]?.verdict,
          value = row.finalCriteria[key];
        if (
          expected &&
          ["pass", "fail"].includes(value) &&
          value !== expected &&
          cascades.find(
            (other) => other.arm === "baseline" && other.caseId === row.caseId,
          )?.finalCriteria[key] !== value
        )
          newWrongDownstream.push(`${row.caseId}/${key}`);
      }
    const guards = {
      q02Rejected:
        rows.find((row) => row.caseId === "Q02" && row.arm === "clarified")
          ?.verdict === "fail",
      sourceCorrectnessImproved:
        summaries.clarified.overall.correct >
        summaries.baseline.overall.correct,
      noNewWrongSource: newWrongSource.length === 0,
      noNewWrongLabeledDownstream: newWrongDownstream.length === 0,
      newCohortNotWorse:
        summaries.clarified.new.correct >= summaries.baseline.new.correct,
      validRewritesNotWorse:
        summaries.clarified.new.correctPass >=
          summaries.baseline.new.correctPass &&
        summaries.clarified.existing.correctPass >=
          summaries.baseline.existing.correctPass,
      cascadeCorrectnessNotWorse:
        cascadeSummaries.clarified.correct >= cascadeSummaries.baseline.correct,
      noTechnicalErrors:
        summaries.baseline.overall.errors +
          summaries.clarified.overall.errors ===
        0,
    };
    const success = {
      met: Object.values(guards).every(Boolean),
      guards,
      newWrongSource,
      newWrongDownstream,
    };
    await immutable(join(output, "results.json"), {
      protocolHash,
      summaries,
      cascadeSummaries,
      success,
      billing,
      cases: rows,
      cascades,
    });
    const lines = [
      "# Kimi: assenza di supporto e giudizio incerto",
      "",
      "Confronto appaiato: stesse fonti e criteri selezionati, 52 nuove chiamate Kimi, una per caso e formulazione. Nessuna chiamata Jev e nessuna modifica alle soglie o alla produzione. I 12 nuovi casi sono stati preparati separatamente dal prompt candidato, con fonti e risultati attesi fissati prima delle chiamate.",
      "",
      "## Risultati sul supporto delle fonti",
      "",
      "| Campione / istruzioni | N | Corretti | Pass corretti | Fail corretti | Falsi pass | Falsi fail | Incerti | Errori |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ];
    for (const cohort of ["existing", "new", "overall"] as const)
      for (const arm of KIMI_SOURCE_CONTRACT_ARMS) {
        const s = summaries[arm][cohort];
        lines.push(
          `| ${cohort} / ${arm} | ${s.total} | ${s.correct} | ${s.correctPass} | ${s.correctFail} | ${s.falsePass} | ${s.falseFail} | ${s.uncertain} | ${s.errors} |`,
        );
      }
    lines.push(
      "",
      "## Per tipo di aggiunta",
      "",
      "| Categoria / istruzioni | N | Corretti | Falsi pass/fail | Incerti/errori |",
      "|---|---:|---:|---|---|",
    );
    for (const category of Object.keys(summaries.baseline.byCategory))
      for (const arm of KIMI_SOURCE_CONTRACT_ARMS) {
        const s = summaries[arm].byCategory[category];
        lines.push(
          `| ${category} / ${arm} | ${s.total} | ${s.correct} | ${s.falsePass}/${s.falseFail} | ${s.uncertain}/${s.errors} |`,
        );
      }
    lines.push(
      "",
      "## Istruzione aggiunta",
      "",
      KIMI_SOURCE_CONTRACT_CLARIFICATION,
      "",
      "## Casi e motivazioni",
      "",
    );
    for (const probe of probes) {
      lines.push(
        `### ${probe.caseId} — ${probe.label}`,
        "",
        `Atteso: **${probe.expectedVerdict}**. ${probe.rationale}`,
        "",
      );
      for (const arm of KIMI_SOURCE_CONTRACT_ARMS) {
        const row = rows.find(
          (row) => row.caseId === probe.caseId && row.arm === arm,
        );
        assert.ok(row);
        lines.push(
          `**${arm}: ${row.verdict}.** ${row.outcome.status === "success" ? row.outcome.result.judgments[SOURCE]?.rationale : `Errore tecnico: ${row.outcome.error.kind}`}`,
          "",
        );
        if (row.outcome.status === "success")
          for (const key of row.selected.filter((key) => key !== SOURCE))
            lines.push(
              `Altro criterio ${key}: **${row.outcome.result.judgments[key]?.verdict}**. ${row.outcome.result.judgments[key]?.rationale}`,
              "",
            );
      }
    }
    lines.push(
      "## Ricostruzione della cascata",
      "",
      contract.reconstruction,
      "",
      "```json",
      json(cascadeSummaries).trim(),
      "```",
      "",
      "## Esito del criterio fissato prima del test",
      "",
      "```json",
      json(success).trim(),
      "```",
      "",
      "## Costi effettivi",
      "",
      "Sono escluse le risposte storiche riutilizzate. I costi mancanti non equivalgono a zero.",
      "",
      "```json",
      json(billing).trim(),
      "```",
      "",
      "## Limiti",
      "",
      contract.limitations,
      "",
      "Il confronto usa istruzioni attuali chiamate nuovamente: un eventuale miglioramento rispetto al solo run storico non dimostra un effetto del nuovo prompt. Le chiamate diagnostiche forzate non misurano il numero di deleghe della cascata. Le risposte sugli altri criteri selezionati di Q02/Q21 sono riportate, per distinguere l'effetto sul supporto da effetti collaterali. Nessuna modifica o promozione automatica in produzione.",
    );
    const report = `${lines.join("\n")}\n`,
      savedReport = await optional(join(output, "rapporto.md"));
    if (savedReport !== undefined) assert.equal(savedReport, report);
    else
      await writeFile(join(output, "rapporto.md"), report, {
        flag: "wx",
        mode: 0o600,
      });
    console.log(json({ summaries, cascadeSummaries, success, billing }));
  } finally {
    await rm(lock);
  }
}
main().catch((error) => {
  console.error(
    error instanceof GatewayRequestError
      ? "Provider configuration failed"
      : error instanceof Error
        ? error.message
        : "Kimi experiment failed",
  );
  process.exitCode = 1;
});
