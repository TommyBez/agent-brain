import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadEnvConfig } from "@next/env";
import { DEFECT_CONSOLIDATION_QUESTIONS } from "../lib/maintenance/consolidation-defect-questions";
import {
  CONSOLIDATION_CRITERIA,
  CONSOLIDATION_QUESTIONS_V2,
  type ConsolidationCriterion,
} from "../lib/maintenance/consolidation-rubric";
import {
  type DefectBand,
  decideDefectRisk,
} from "../lib/maintenance/defect-threshold-method";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import {
  type ConsolidationEvaluationInput,
  evaluateConsolidationProposal,
  JEV_MODEL,
} from "../lib/maintenance/jev";
import {
  evaluateWithKimi,
  KIMI_EVALUATOR_SETTINGS,
  type KimiEvaluation,
  KimiResponseError,
} from "../lib/maintenance/kimi-evaluator";
import { buildFilterContract } from "./prepare-filter-contract";

// Isolated fixed-input benchmark. Never generates proposals or writes to Brain.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prior = "artifacts/consolidation/2026-09-18-jev-defect-polarity";
const criteria = CONSOLIDATION_CRITERIA;
type Criterion = ConsolidationCriterion;
type Bands = Record<Criterion, DefectBand>;
type Verdict = "pass" | "fail" | "uncertain" | "error" | "not_evaluated";
type Decision = "accept" | "reject" | "uncertain" | "error";
type JevResult = Pick<
  Awaited<ReturnType<typeof evaluateConsolidationProposal>>,
  "answers" | "model" | "usage"
>;
type SafeError = {
  kind: string;
  status: number | null;
  diagnostic?: {
    stage: string;
    reasonCode: string;
    usage: KimiEvaluation["usage"];
    responseId: string | null;
    responseModel: string | null;
    latencyMs: number;
  };
};
type Outcome<T> =
  | { status: "success"; result: T }
  | { status: "error"; error: SafeError };
type Dependencies = {
  jev: (input: ConsolidationEvaluationInput) => Promise<Outcome<JevResult>>;
  kimi: (
    input: ConsolidationEvaluationInput,
    selected: Criterion[],
  ) => Promise<Outcome<KimiEvaluation>>;
};
const hash = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const mapCriteria = <T>(fn: (criterion: Criterion) => T) =>
  Object.fromEntries(criteria.map((key) => [key, fn(key)])) as Record<
    Criterion,
    T
  >;
async function optional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function immutable(path: string, value: unknown) {
  const text = json(value),
    old = await optional(path);
  if (old !== undefined)
    assert.equal(old, text, `Frozen artifact changed: ${path}`);
  else await writeFile(path, text, { flag: "wx", mode: 0o600 });
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
      kind:
        error.status !== null
          ? "http"
          : /invalid/.test(error.message)
            ? "invalid_response"
            : "transport_or_configuration",
      status: error.status,
    };
  return { kind: "unexpected", status: null };
}

export function routeFixedRisk(answers: Record<string, number>, bands: Bands) {
  return mapCriteria((key) => {
    assert.ok(
      Number.isFinite(answers[key]) && answers[key] >= 0 && answers[key] <= 1,
      "Invalid Jev score",
    );
    return decideDefectRisk(Number(answers[key].toFixed(12)), bands[key]);
  });
}

export async function evaluateFixedCase(
  input: ConsolidationEvaluationInput,
  bands: Bands,
  deps: Dependencies,
) {
  // Explicit projection: metadata and expected answers can never reach either adapter.
  const clean = {
    before: input.before,
    after: input.after,
    evidence: input.evidence,
    operation: input.operation,
  };
  const jev = await deps.jev(clean);
  if (jev.status === "error")
    return {
      jev,
      kimi: null,
      risk: null,
      route: "error" as const,
      jevCriteria: mapCriteria(() => "error" as const),
      finalCriteria: mapCriteria(() => "error" as Verdict),
      finalDecision: "error" as Decision,
      selected: [] as Criterion[],
    };
  const risk = mapCriteria((key) =>
    Number(jev.result.answers[key].toFixed(12)),
  );
  const routing = routeFixedRisk(risk, bands);
  const jevCriteria = mapCriteria((key) =>
    routing[key] === "allow"
      ? "pass"
      : routing[key] === "reject"
        ? "fail"
        : "defer",
  );
  const red = criteria.some((key) => routing[key] === "reject");
  const selected = red
    ? []
    : criteria.filter((key) => routing[key] === "defer");
  const kimi = selected.length ? await deps.kimi(clean, selected) : null;
  const finalCriteria = mapCriteria<Verdict>((key) => {
    if (routing[key] === "allow") return "pass";
    if (routing[key] === "reject") return "fail";
    if (red) return "not_evaluated";
    if (kimi?.status !== "success") return "error";
    return kimi.result.judgments[key]?.verdict ?? "error";
  });
  const values = Object.values(finalCriteria);
  const finalDecision: Decision = values.includes("error")
    ? "error"
    : values.includes("fail")
      ? "reject"
      : values.includes("uncertain")
        ? "uncertain"
        : "accept";
  return {
    jev,
    kimi,
    risk,
    route: red ? "reject" : selected.length ? "defer" : "accept",
    jevCriteria,
    finalCriteria,
    finalDecision,
    selected,
  };
}

type CaseResult = Awaited<ReturnType<typeof evaluateFixedCase>>;
type Reference = ReturnType<
  typeof buildFilterContract
>["reference"]["cases"][number];
type Row = CaseResult & Reference;
const counters = () => ({ accept: 0, reject: 0, uncertain: 0, error: 0 });
function summarize(rows: Row[]) {
  const valid = counters(),
    invalid = counters();
  for (const row of rows)
    (row.expectedDecision === "accept" ? valid : invalid)[row.finalDecision]++;
  const criterionSummary = mapCriteria((key) => {
    const relevant = rows.filter((row) => row.expectedCriteria[key]);
    const positive = relevant.filter(
      (row) => row.expectedCriteria[key]?.verdict === "pass",
    );
    const negative = relevant.filter(
      (row) => row.expectedCriteria[key]?.verdict === "fail",
    );
    const count = (
      subset: Row[],
      field: "jevCriteria" | "finalCriteria",
      value: string,
    ) => subset.filter((row) => row[field][key] === value).length;
    return {
      referencePass: positive.length,
      referenceFail: negative.length,
      notScored: rows.length - relevant.length,
      jev: {
        correctPass: count(positive, "jevCriteria", "pass"),
        falseReject: count(positive, "jevCriteria", "fail"),
        correctReject: count(negative, "jevCriteria", "fail"),
        falsePass: count(negative, "jevCriteria", "pass"),
        deferred: count(relevant, "jevCriteria", "defer"),
        errors: count(relevant, "jevCriteria", "error"),
      },
      cascade: {
        correctPass: count(positive, "finalCriteria", "pass"),
        falseReject: count(positive, "finalCriteria", "fail"),
        correctReject: count(negative, "finalCriteria", "fail"),
        falsePass: count(negative, "finalCriteria", "pass"),
        uncertain: count(relevant, "finalCriteria", "uncertain"),
        errors: count(relevant, "finalCriteria", "error"),
        notEvaluated: count(relevant, "finalCriteria", "not_evaluated"),
      },
      kimi: {
        requested: rows.filter((row) => row.selected.includes(key)).length,
        scored: relevant.filter((row) => row.selected.includes(key)).length,
        correct: relevant.filter(
          (row) =>
            row.kimi?.status === "success" &&
            row.kimi.result.judgments[key]?.verdict ===
              row.expectedCriteria[key]?.verdict,
        ).length,
      },
    };
  });
  let jevUsd = 0,
    kimiUsd = 0,
    unknownCosts = 0;
  for (const row of rows) {
    const j =
      row.jev.status === "success"
        ? row.jev.result.usage.gateway?.cost
        : undefined;
    if (j === undefined) unknownCosts++;
    else jevUsd += j;
    if (row.kimi) {
      const k =
        row.kimi.status === "success"
          ? row.kimi.result.usage.costUsd
          : row.kimi.error.diagnostic?.usage.costUsd;
      if (k === undefined || k === null) unknownCosts++;
      else kimiUsd += k;
    }
  }
  return {
    valid,
    invalid,
    correct: valid.accept + invalid.reject,
    total: rows.length,
    jevRouting: {
      accept: rows.filter((row) => row.route === "accept").length,
      reject: rows.filter((row) => row.route === "reject").length,
      defer: rows.filter((row) => row.route === "defer").length,
      error: rows.filter((row) => row.route === "error").length,
    },
    kimiCalls: rows.filter((row) => row.kimi).length,
    criteria: criterionSummary,
    costs: {
      jevUsd,
      kimiUsd,
      totalKnownUsd: jevUsd + kimiUsd,
      callsWithUnknownCost: unknownCosts,
    },
  };
}

function renderReport(
  rows: Row[],
  bands: Bands,
  summary: ReturnType<typeof summarize>,
) {
  const lines = [
    "# Test del filtro Jev + Kimi sui 24 casi approvati",
    "",
    "Una valutazione per proposta, su sei scenari costruiti. DeepSeek escluso. Le risposte attese sono quelle del contratto approvato, mai inviate ai modelli. Nessuna soglia ricalibrata su questi risultati.",
    "",
    `Proposte valide accettate: **${summary.valid.accept}/8**. Proposte scorrette respinte: **${summary.invalid.reject}/16**. Risultati corretti: **${summary.correct}/24**.`,
    `Falsi via libera: **${summary.invalid.accept}**; falsi blocchi: **${summary.valid.reject}**; incertezze finali: **${summary.valid.uncertain + summary.invalid.uncertain}**; errori tecnici: **${summary.valid.error + summary.invalid.error}**.`,
    `Jev decide da solo ${summary.jevRouting.accept + summary.jevRouting.reject}/24 proposte (${summary.jevRouting.accept} accettate, ${summary.jevRouting.reject} respinte). Kimi riceve **${summary.kimiCalls}/24** proposte, esclusivamente sui criteri intermedi.`,
    `Costi dichiarati dal Gateway: Jev $${summary.costs.jevUsd.toFixed(8)}; Kimi $${summary.costs.kimiUsd.toFixed(8)}; totale noto $${summary.costs.totalKnownUsd.toFixed(8)}. Chiamate con costo non disponibile: ${summary.costs.callsWithUnknownCost}.`,
    "",
    "## Soglie fissate prima del test",
    "",
    "Il punteggio Jev indica rischio di difetto: sotto L passa; da U in su boccia; nell'intervallo [L,U) delega. Sono punteggi del modello, non probabilità di errore calibrate.",
    "",
    "| Criterio | L | U |",
    "|---|---:|---:|",
  ];
  for (const key of criteria)
    lines.push(
      `| ${key} | ${bands[key].allowBelow} | ${bands[key].rejectAtOrAbove} |`,
    );
  lines.push(
    "",
    "## Risultati per criterio",
    "",
    "Sono misurati solo i riferimenti espliciti. Un criterio grigio non esaminato perché un altro ha già bocciato la proposta resta non valutato. Le deleghe non sono errori.",
    "",
    "| Criterio | Pass/fail attesi | Jev: pass corretti / fail corretti | Jev: falsi pass / falsi blocchi | Jev: deleghe | Cascata: pass corretti / fail corretti | Cascata: falsi pass / falsi blocchi | Non valutati / incerti / errori |",
    "|---|---|---|---|---:|---|---|---|",
  );
  for (const key of criteria) {
    const c = summary.criteria[key];
    lines.push(
      `| ${key} | ${c.referencePass}/${c.referenceFail} | ${c.jev.correctPass}/${c.jev.correctReject} | ${c.jev.falsePass}/${c.jev.falseReject} | ${c.jev.deferred} | ${c.cascade.correctPass}/${c.cascade.correctReject} | ${c.cascade.falsePass}/${c.cascade.falseReject} | ${c.cascade.notEvaluated}/${c.cascade.uncertain}/${c.cascade.errors} |`,
    );
  }
  lines.push(
    "",
    "## Tutte le decisioni",
    "",
    "| Caso | Variante | Atteso | Jev | Criteri a Kimi | Finale |",
    "|---|---|---|---|---|---|",
  );
  for (const row of [...rows].sort((a, b) =>
    a.designId.localeCompare(b.designId),
  ))
    lines.push(
      `| ${row.caseId} | ${row.designId} — ${row.label} | ${row.expectedDecision} | ${row.route} | ${row.selected.join(", ") || "—"} | ${row.finalDecision} |`,
    );
  lines.push("", "## Dettaglio dei punteggi e delle motivazioni", "");
  for (const row of [...rows].sort((a, b) =>
    a.designId.localeCompare(b.designId),
  )) {
    lines.push(
      `### ${row.designId} / ${row.caseId} — ${row.label}`,
      "",
      `Atteso: **${row.expectedDecision}**. Finale: **${row.finalDecision}**. ${row.rationale}`,
      "",
      "| Criterio | Rischio Jev | Esito Jev | Esito finale |",
      "|---|---:|---|---|",
    );
    for (const key of criteria)
      lines.push(
        `| ${key} | ${row.risk?.[key] ?? "—"} | ${row.jevCriteria[key]} | ${row.finalCriteria[key]} |`,
      );
    if (row.kimi?.status === "success")
      for (const key of row.selected)
        lines.push(
          "",
          `**Kimi — ${key}:** ${row.kimi.result.judgments[key]?.rationale}`,
        );
    for (const receipt of [row.jev, row.kimi])
      if (receipt?.status === "error")
        lines.push(
          "",
          `Errore tecnico: ${receipt.error.kind}; HTTP ${receipt.error.status ?? "non disponibile"}; dettaglio ${receipt.error.diagnostic?.reasonCode ?? "non disponibile"}.`,
        );
    lines.push("");
  }
  lines.push(
    "## Limiti",
    "",
    "Il risultato misura questo contratto di 24 proposte su sei scenari correlati, con una sola esecuzione per proposta. Non stima l'affidabilità sull'intera base reale né la stabilità fra ripetizioni. Non è stato chiamato Kimi sui casi decisi automaticamente da Jev, quindi non è un confronto con Kimi usato da solo. Nessuna modifica applicata alla produzione.",
  );
  return `${lines.join("\n")}\n`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      output: { type: "string" },
      mode: { type: "string", default: "prepare" },
    },
  });
  assert.ok(
    values.input && values.output,
    "Use --input <dataset> --output <run> --mode prepare|run|verify",
  );
  assert.ok(["prepare", "run", "verify"].includes(values.mode));
  const dataset = resolve(values.input),
    output = resolve(values.output);
  const fixtureText = await readFile(
    join(root, "scripts/fixtures/consolidation-filter-contract.json"),
    "utf8",
  );
  const built = buildFilterContract(JSON.parse(fixtureText));
  const sources: Record<string, string> = {};
  for (const file of [
    "inputs.json",
    "reference.json",
    "manifest.json",
    "casi.md",
  ])
    sources[file] = await readFile(join(dataset, file), "utf8");
  assert.deepEqual(JSON.parse(sources["inputs.json"]), built.inputs);
  assert.deepEqual(JSON.parse(sources["reference.json"]), built.reference);
  const manifest = JSON.parse(sources["manifest.json"]);
  assert.equal(manifest.fixtureHash, hash(fixtureText));
  for (const [name, key] of [
    ["inputs.json", "inputsHash"],
    ["reference.json", "referenceHash"],
    ["casi.md", "reviewHash"],
  ])
    assert.equal(hash(sources[name]), manifest[key]);
  assert.equal(manifest.rubricHash, hash(json(CONSOLIDATION_QUESTIONS_V2)));
  assert.equal(built.manifestSummary.proposals, 24);
  assert.equal(built.manifestSummary.expectedAccept, 8);
  assert.equal(built.manifestSummary.expectedReject, 16);
  const selectionText = await readFile(
    join(root, prior, "selection.json"),
    "utf8",
  );
  const questionsText = await readFile(
    join(root, prior, "questions.json"),
    "utf8",
  );
  assert.deepEqual(
    JSON.parse(questionsText).defect,
    DEFECT_CONSOLIDATION_QUESTIONS,
  );
  const selection = JSON.parse(selectionText);
  const bands: Bands = mapCriteria(
    (key) => selection.criteria.defect[key].dual,
  );
  for (const band of Object.values(bands))
    assert.ok(
      Number.isFinite(band.allowBelow) &&
        Number.isFinite(band.rejectAtOrAbove) &&
        band.allowBelow >= 0 &&
        band.rejectAtOrAbove <= 1.01 &&
        band.allowBelow <= band.rejectAtOrAbove,
    );
  const codeHashes: Record<string, string> = {};
  for (const path of [
    "package.json",
    "pnpm-lock.yaml",
    "scripts/evaluate-filter-contract.ts",
    "scripts/prepare-filter-contract.ts",
    "lib/maintenance/jev.ts",
    "lib/maintenance/kimi-evaluator.ts",
    "lib/maintenance/gateway.ts",
    "lib/maintenance/defect-threshold-method.ts",
    "lib/maintenance/consolidation-rubric.ts",
    "lib/maintenance/consolidation-defect-questions.ts",
  ])
    codeHashes[path] = hash(await readFile(join(root, path)));
  const contract = {
    version: 1,
    datasetHashes: Object.fromEntries(
      Object.entries(sources).map(([name, text]) => [name, hash(text)]),
    ),
    fixtureHash: hash(fixtureText),
    codeHashes,
    selectionSource: prior,
    selectionHash: hash(selectionText),
    questionsSourceHash: hash(questionsText),
    jevModel: JEV_MODEL,
    questions: DEFECT_CONSOLIDATION_QUESTIONS,
    bands,
    kimiSettings: KIMI_EVALUATOR_SETTINGS,
    rubric: CONSOLIDATION_QUESTIONS_V2,
    repetitions: 1,
    maxAttemptsPerJob: 1,
    concurrency: 3,
    routing:
      "Risk is raw Jev score rounded to 12 decimals. risk<L passes; risk>=U fails. Any fail rejects, all pass accepts, else Kimi judges only gray criteria. Technical errors and uncertain remain separate.",
    missingCriterionPolicy: "not_scored",
    baselineKimi: false,
  };
  if (values.mode === "run") {
    loadEnvConfig(root);
    assert.ok(
      process.env.AI_GATEWAY_API_KEY?.trim(),
      "AI Gateway key not available",
    );
  }
  await mkdir(output, { recursive: true, mode: 0o700 });
  const lock = join(output, ".lock");
  await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  try {
    const old = await optional(join(output, "protocol.json"));
    if (values.mode === "verify") assert.ok(old, "No frozen protocol");
    const protocol = old
      ? JSON.parse(old)
      : { frozenAt: new Date().toISOString(), contract };
    assert.deepEqual(
      protocol.contract,
      contract,
      "Inputs or evaluation protocol changed",
    );
    await immutable(join(output, "protocol.json"), protocol);
    if (values.mode === "prepare") {
      console.log(JSON.stringify({ status: "prepared", cases: 24, bands }));
      return;
    }
    const protocolHash = hash(json(protocol));
    const receipts = join(output, "receipts");
    await mkdir(receipts, { recursive: true, mode: 0o700 });
    const runJob = async <T>(
      caseId: string,
      inputHash: string,
      kind: string,
      selected: Criterion[],
      call: () => Promise<T>,
    ): Promise<Outcome<T>> => {
      const identity = { protocolHash, caseId, inputHash, kind, selected };
      const path = join(receipts, `${caseId}-${kind}.json`);
      const saved = await optional(path);
      if (saved) {
        const receipt = JSON.parse(saved);
        assert.deepEqual(
          receipt.identity,
          identity,
          "Receipt identity mismatch",
        );
        assert.equal(
          receipt.outcomeHash,
          hash(json(receipt.outcome)),
          "Receipt checksum mismatch",
        );
        return receipt.outcome;
      }
      assert.notEqual(
        values.mode,
        "verify",
        `Missing receipt: ${caseId}/${kind}`,
      );
      const startedAt = new Date().toISOString();
      // A start without receipt has an unknown provider outcome. Never replay silently.
      await immutable(`${path}.started`, { identity, startedAt });
      let outcome: Outcome<T>;
      try {
        outcome = { status: "success", result: await call() };
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
    };
    const rows: Row[] = [];
    let next = 0,
      completed = 0;
    const workers = await Promise.allSettled(
      Array.from({ length: contract.concurrency }, async () => {
        while (next < built.inputs.cases.length) {
          const item = built.inputs.cases[next++];
          const reference = built.reference.cases.find(
            (row) => row.caseId === item.caseId,
          );
          assert.ok(reference);
          const result = await evaluateFixedCase(item.input, bands, {
            jev: (clean) =>
              runJob(item.caseId, item.inputHash, "jev", [...criteria], () =>
                evaluateConsolidationProposal(clean, {
                  questions: DEFECT_CONSOLIDATION_QUESTIONS,
                }),
              ),
            kimi: (clean, selected) =>
              runJob(item.caseId, item.inputHash, "kimi", selected, () =>
                evaluateWithKimi(clean, selected),
              ),
          });
          rows.push({ ...reference, ...result });
          console.log(
            JSON.stringify({
              mode: values.mode,
              completed: ++completed,
              total: 24,
              caseId: item.caseId,
            }),
          );
        }
      }),
    );
    for (const worker of workers)
      if (worker.status === "rejected") throw worker.reason;
    rows.sort((a, b) => a.caseId.localeCompare(b.caseId));
    const summary = summarize(rows);
    await immutable(join(output, "results.json"), {
      protocolHash,
      summary,
      cases: rows,
    });
    const report = renderReport(rows, bands, summary),
      reportPath = join(output, "rapporto.md");
    const oldReport = await optional(reportPath);
    if (oldReport !== undefined) assert.equal(oldReport, report);
    else await writeFile(reportPath, report, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify(summary));
  } finally {
    await rm(lock);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(
      error instanceof GatewayRequestError
        ? "Provider configuration failed"
        : error instanceof Error
          ? error.message
          : "Fixed benchmark failed",
    );
    process.exitCode = 1;
  });
