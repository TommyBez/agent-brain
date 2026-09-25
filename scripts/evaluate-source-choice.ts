import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadEnvConfig } from "@next/env";
import {
  CONSOLIDATION_CRITERIA,
  CONSOLIDATION_QUESTIONS_V2,
} from "../lib/maintenance/consolidation-rubric";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import {
  evaluateSourceSupport,
  JEV_SOURCE_ARMS,
  JEV_SOURCE_QUESTIONS,
  type SourceSupportArm,
} from "../lib/maintenance/jev-source-evaluator";
import {
  evaluateWithKimi,
  KIMI_EVALUATOR_SETTINGS,
  KimiResponseError,
} from "../lib/maintenance/kimi-evaluator";
import { evaluateFixedCase } from "./evaluate-filter-contract";
import { buildFilterContract } from "./prepare-filter-contract";

// Controlled component experiment. No proposal generation or Brain writes.
const root = process.cwd();
const dataset = join(root, "artifacts/consolidation/jev-kimi-fixed-v1");
const baseline = join(dataset, "run-defect-sdk-v2");
const sourceKey = "supported_by_evidence";
const criteria = CONSOLIDATION_CRITERIA;
type Criterion = (typeof criteria)[number];
type Evaluation = Awaited<ReturnType<typeof evaluateFixedCase>>;
type SafeError = Extract<Evaluation["jev"], { status: "error" }>["error"];
type Outcome<T> =
  | { status: "success"; result: T }
  | { status: "error"; error: SafeError };
type Reference = ReturnType<
  typeof buildFilterContract
>["reference"]["cases"][number];
type Row = Reference &
  Evaluation & {
    arm: SourceSupportArm;
    source: Outcome<Awaited<ReturnType<typeof evaluateSourceSupport>>>;
    kimiReceipt: string | null;
  };
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
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
      kind:
        error.status !== null
          ? "http"
          : /invalid/i.test(error.message)
            ? "invalid_response"
            : "transport_or_configuration",
      status: error.status,
    };
  return { kind: "unexpected", status: null };
}
async function workers<T>(
  items: T[],
  work: (item: T, index: number) => Promise<void>,
) {
  let cursor = 0;
  const results = await Promise.allSettled(
    Array.from({ length: 3 }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        await work(items[index], index);
      }
    }),
  );
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
}
function criterionSummary(
  rows: Row[],
  key: Criterion,
  field: "jevCriteria" | "finalCriteria",
) {
  const count = {
    scored: 0,
    correctPass: 0,
    correctFail: 0,
    falsePass: 0,
    falseFail: 0,
    defer: 0,
    uncertain: 0,
    error: 0,
    not_evaluated: 0,
  };
  for (const row of rows) {
    const expected = row.expectedCriteria[key]?.verdict;
    if (!expected) continue;
    count.scored++;
    const actual = row[field][key];
    if (actual === "pass")
      count[expected === "pass" ? "correctPass" : "falsePass"]++;
    else if (actual === "fail")
      count[expected === "fail" ? "correctFail" : "falseFail"]++;
    else count[actual]++;
  }
  return count;
}
function summarize(rows: Row[]) {
  const count = (fn: (row: Row) => boolean) => rows.filter(fn).length;
  const jevCost = rows.reduce(
    (sum, row) =>
      sum +
      (row.source.status === "success"
        ? (row.source.result.usage.gateway?.cost ?? 0)
        : 0),
    0,
  );
  const kimiCost = rows.reduce(
    (sum, row) =>
      sum +
      (row.kimi?.status === "success"
        ? (row.kimi.result.usage.costUsd ?? 0)
        : (row.kimi?.error.diagnostic?.usage.costUsd ?? 0)),
    0,
  );
  return {
    cases: rows.length,
    correct: count((row) => row.finalDecision === row.expectedDecision),
    acceptedValid: count(
      (row) =>
        row.expectedDecision === "accept" && row.finalDecision === "accept",
    ),
    rejectedInvalid: count(
      (row) =>
        row.expectedDecision === "reject" && row.finalDecision === "reject",
    ),
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
    jevDirect: count((row) => row.route === "accept" || row.route === "reject"),
    kimiCalls: count((row) => row.kimi !== null),
    kimiSourceJudgments: count((row) => row.selected.includes(sourceKey)),
    perCriterion: Object.fromEntries(
      criteria.map((key) => [
        key,
        {
          jev: criterionSummary(rows, key, "jevCriteria"),
          cascade: criterionSummary(rows, key, "finalCriteria"),
          kimiRequested: count((row) => row.selected.includes(key)),
        },
      ]),
    ),
    costUsd: {
      jev: jevCost,
      kimi: kimiCost,
      total: jevCost + kimiCost,
      meaning:
        "Attributable receipt costs for this arm; shared Kimi receipts are counted in each arm, but billed once in the actual experiment. Excludes historical frozen Jev scores.",
    },
  };
}
function render(
  rows: Row[],
  summaries: Record<SourceSupportArm, ReturnType<typeof summarize>>,
  actual: unknown,
) {
  const b = summaries.binary,
    c = summaries.choice;
  const lines = [
    "# Confronto Jev binario / classificazione delle fonti",
    "",
    "24 proposte già preparate; nessuna generazione DeepSeek e nessuna scrittura in Brain. 48 nuove chiamate a Jev, con una sola domanda per chiamata. Per entrambi i percorsi gli altri tre punteggi sono congelati dal run precedente. Kimi usa il prompt invariato e riceve solo i criteri grigi: richieste identiche condividono una nuova ricevuta.",
    "",
    "Soglie fissate prima delle chiamate: P(difetto)<0,12 passa; P(difetto)≥0,94 boccia; altrimenti delega. Per Choice P(difetto)=P(contradicted)+P(unsupported). Non si usa né si ricostruisce la confidence nativa. Sono classificate le modifiche dell'intera proposta; una contraddizione ha precedenza se coesiste con aggiunte non supportate.",
    "",
    "| Misura | Binario nuovo | Choice nuovo |",
    "|---|---:|---:|",
    `| Decisioni corrette / 24 | ${b.correct} | ${c.correct} |`,
    `| Valide accettate / 8 | ${b.acceptedValid} | ${c.acceptedValid} |`,
    `| Errate bocciate / 16 | ${b.rejectedInvalid} | ${c.rejectedInvalid} |`,
    `| False accettazioni / false bocciature | ${b.falseAccept}/${b.falseReject} | ${c.falseAccept}/${c.falseReject} |`,
    `| Incerte / errori tecnici | ${b.uncertain}/${b.errors} | ${c.uncertain}/${c.errors} |`,
    `| Chiamate Kimi richieste dal percorso | ${b.kimiCalls} | ${c.kimiCalls} |`,
    `| Giudizi sulle fonti richiesti a Kimi | ${b.kimiSourceJudgments} | ${c.kimiSourceJudgments} |`,
    "",
    "## Risultati per criterio",
    "",
    "Solo i riferimenti espliciti sono conteggiati: sulle fonti 8 pass e 6 fail attesi. Gli altri 10 casi non hanno un'etichetta per questo criterio. Non esistono etichette di riferimento separate per contradicted e unsupported.",
    "",
    "| Criterio / metodo | N | Jev: pass/fail corretti | Jev: falsi pass/fail | Grigi | Cascata: pass/fail corretti | Cascata: falsi pass/fail | Incerti/errori/non valutati |",
    "|---|---:|---|---|---:|---|---|---|",
  ];
  for (const key of criteria)
    for (const arm of JEV_SOURCE_ARMS) {
      const p = summaries[arm].perCriterion[key],
        j = p.jev,
        f = p.cascade;
      lines.push(
        `| ${key} / ${arm} | ${j.scored} | ${j.correctPass}/${j.correctFail} | ${j.falsePass}/${j.falseFail} | ${j.defer} | ${f.correctPass}/${f.correctFail} | ${f.falsePass}/${f.falseFail} | ${f.uncertain}/${f.error}/${f.not_evaluated} |`,
      );
    }
  lines.push(
    "",
    "## Punteggi di tutti i casi",
    "",
    "I punteggi binari attuali sono una nuova misura su domanda singola, non il vecchio batch di quattro domande. Il colore del criterio non equivale sempre a una chiamata Kimi: basta un altro criterio rosso per bocciare direttamente.",
    "",
    "| Caso | Fonti atteso | P difetto binario | P supported / contradicted / unsupported | P difetto Choice | Esito fonti Jev binario → Choice | Finale binario → Choice |",
    "|---|---|---:|---|---:|---|---|",
  );
  for (const row of rows.filter((row) => row.arm === "binary")) {
    const paired = rows.find(
      (other) => other.caseId === row.caseId && other.arm === "choice",
    );
    assert.ok(paired);
    const answer =
      paired.source.status === "success" ? paired.source.result.answer : null;
    const distribution =
      answer?.type === "choice"
        ? [
            answer.probabilities.supported,
            answer.probabilities.contradicted,
            answer.probabilities.unsupported,
          ].join(" / ")
        : "errore";
    lines.push(
      `| ${row.caseId} — ${row.label} | ${row.expectedCriteria[sourceKey]?.verdict ?? "non etichettato"} | ${row.risk?.[sourceKey] ?? "errore"} | ${distribution} | ${paired.risk?.[sourceKey] ?? "errore"} | ${row.jevCriteria[sourceKey]} → ${paired.jevCriteria[sourceKey]} | ${row.finalDecision} → ${paired.finalDecision} |`,
    );
  }
  lines.push(
    "",
    "## Motivazioni Kimi e deleghe",
    "",
    "Un insieme diverso di criteri richiesti può cambiare anche le risposte Kimi sugli altri criteri: è un effetto della cascata. Le richieste identiche condividono la stessa risposta.",
  );
  for (const row of rows.filter((row) => row.kimi !== null)) {
    lines.push(
      "",
      `### ${row.caseId} / ${row.arm} — ${row.label}`,
      "",
      `Atteso: ${row.expectedDecision}; finale: ${row.finalDecision}. Ricevuta: ${row.kimiReceipt}.`,
    );
    if (row.kimi?.status === "success")
      for (const key of row.selected)
        lines.push(
          "",
          `**${key}: ${row.kimi.result.judgments[key]?.verdict}.** ${row.kimi.result.judgments[key]?.rationale}`,
        );
    else lines.push("", "Errore tecnico; dettagli sanitizzati nella ricevuta.");
  }
  lines.push(
    "",
    "## Costi",
    "",
    "Costi restituiti dal provider. La somma dei costi attribuiti ai due percorsi include due volte le ricevute Kimi condivise; il costo fisico le conta una volta. I tre punteggi storici riutilizzati non sono stati fatturati in questo esperimento.",
    "",
    "```json",
    json({ binary: b.costUsd, choice: c.costUsd, actual }).trim(),
    "```",
    "",
    "## Interpretazione e limiti",
    "",
    "Il test confronta due formulazioni e primitive con le medesime soglie; non dimostra che le distribuzioni siano calibrate allo stesso modo. Nessuna soglia è stata modificata dopo le risposte. Il criterio di interesse fissato prima del run è ottenere più decisioni corrette o meno chiamate Kimi senza introdurre errori nuovi, anche sui criteri esplicitamente etichettati. Una riduzione dei soli giudizi sulle fonti resta un beneficio secondario, non un risparmio di chiamate.",
    "",
    "Il dataset contiene 24 varianti correlate di sei scenari già noti, con una sola misura per formulazione. Questi sono risultati di sviluppo: eventuali vantaggi richiedono conferma su casi nuovi. Nessuna modifica al processo di produzione.",
  );
  return `${lines.join("\n")}\n`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", default: "prepare" },
      output: { type: "string" },
    },
  });
  assert.ok(
    values.output && ["prepare", "run", "verify"].includes(values.mode),
    "Use --output <path> --mode prepare|run|verify",
  );
  const output = resolve(values.output);
  const built = buildFilterContract(
    JSON.parse(
      await readFile(
        join(root, "scripts/fixtures/consolidation-filter-contract.json"),
        "utf8",
      ),
    ),
  );
  assert.equal(
    new Set(built.inputs.cases.map((item) => item.inputHash)).size,
    24,
  );
  const priorProtocolText = await readFile(
    join(baseline, "protocol.json"),
    "utf8",
  );
  const priorProtocol = JSON.parse(priorProtocolText);
  const hashes: Record<string, string> = {};
  for (const [name, expected] of Object.entries(
    priorProtocol.contract.datasetHashes,
  )) {
    const text = await readFile(join(dataset, name), "utf8");
    assert.equal(hash(text), expected);
    hashes[`dataset/${name}`] = hash(text);
  }
  assert.deepEqual(
    JSON.parse(await readFile(join(dataset, "inputs.json"), "utf8")),
    built.inputs,
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(dataset, "reference.json"), "utf8")),
    built.reference,
  );
  hashes["baseline/protocol.json"] = hash(priorProtocolText);
  const oldResultsText = await readFile(join(baseline, "results.json"), "utf8");
  const oldResults = JSON.parse(oldResultsText);
  assert.equal(oldResults.protocolHash, hash(priorProtocolText));
  hashes["baseline/results.json"] = hash(oldResultsText);
  const frozenScores: Record<string, Record<string, number>> = {};
  for (const item of built.inputs.cases) {
    assert.equal(item.inputHash, hash(JSON.stringify(item.input)));
    const text = await readFile(
        join(baseline, "receipts", `${item.caseId}-jev.json`),
        "utf8",
      ),
      receipt = JSON.parse(text);
    assert.equal(receipt.identity.protocolHash, oldResults.protocolHash);
    assert.equal(receipt.identity.inputHash, item.inputHash);
    assert.equal(receipt.identity.caseId, item.caseId);
    assert.equal(receipt.outcomeHash, hash(json(receipt.outcome)));
    assert.equal(receipt.outcome.status, "success");
    assert.deepEqual(
      receipt.outcome,
      oldResults.cases.find(
        (row: { caseId: string }) => row.caseId === item.caseId,
      ).jev,
    );
    frozenScores[item.caseId] = receipt.outcome.result.answers;
    hashes[`baseline/receipts/${item.caseId}-jev.json`] = hash(text);
  }
  const codeFiles = [
    "scripts/evaluate-source-choice.ts",
    "lib/maintenance/jev-source-evaluator.ts",
    ...Object.keys(priorProtocol.contract.codeHashes),
  ];
  const codeHashes: Record<string, string> = {};
  for (const path of codeFiles)
    codeHashes[path] = hash(await readFile(join(root, path)));
  for (const path of [
    "lib/maintenance/kimi-evaluator.ts",
    "lib/maintenance/consolidation-rubric.ts",
    "scripts/evaluate-filter-contract.ts",
  ])
    assert.equal(
      codeHashes[path],
      priorProtocol.contract.codeHashes[path],
      `Unchanged component changed: ${path}`,
    );
  const bands = priorProtocol.contract.bands;
  const contract = {
    version: 1,
    hashes,
    codeHashes,
    questions: JEV_SOURCE_QUESTIONS,
    bands,
    kimiSettings: KIMI_EVALUATOR_SETTINGS,
    rubric: CONSOLIDATION_QUESTIONS_V2,
    sourceCalls: 48,
    cases: 24,
    repetitions: 1,
    concurrency: 3,
    maxAttemptsPerJob: 1,
    design:
      "Fresh single-question binary and Choice for each case; alternate arm order by case index. Other 3 Jev scores frozen from run-defect-sdk-v2 in both arms. Primary comparator is fresh binary, not historical batched binary.",
    routing:
      "Reuse evaluateFixedCase. Source risk is binary P(defect) or Choice P(contradicted)+P(unsupported), rounded to 12 decimals. Keep all bands. No native confidence. No probability renormalization.",
    kimiSharing:
      "Fresh Kimi calls; identical inputHash and canonical ordered selectedCriteria share one receipt across arms. Different selected sets are different calls. No Jev score, label or arm reaches Kimi.",
    successRule:
      "More correct final decisions OR fewer Kimi calls, with no new wrong decisions on global or explicitly labeled criterion references (including automatic Jev source decisions), no reduction in final correct decisions, no increase in unresolved outcomes, and no technical errors. Fewer source judgments alone is secondary. Descriptive pilot, not statistical or production validation.",
    missingLabels:
      "not_scored; no three-class correctness score because categorical ground truth has not been labeled",
  };
  await mkdir(output, { recursive: true, mode: 0o700 });
  const lock = join(output, ".lock");
  await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  try {
    const prior = await optional(join(output, "protocol.json"));
    if (values.mode !== "prepare")
      assert.ok(prior, "Prepare and freeze protocol before execution");
    const protocol = prior
      ? JSON.parse(prior)
      : { frozenAt: new Date().toISOString(), contract };
    assert.deepEqual(protocol.contract, contract, "Frozen experiment changed");
    await immutable(join(output, "protocol.json"), protocol);
    if (values.mode === "prepare") {
      console.log(json({ status: "prepared", sourceCalls: 48, output }));
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
      receipts = join(output, "receipts");
    await mkdir(receipts, { recursive: true, mode: 0o700 });
    const consumed = new Map<string, Outcome<unknown>>();
    async function job<T>(
      caseId: string,
      inputHash: string,
      kind: string,
      selected: Criterion[],
      call: () => Promise<T>,
    ): Promise<Outcome<T>> {
      const identity = { protocolHash, caseId, inputHash, kind, selected };
      const id = `${caseId}-${kind}`,
        path = join(receipts, `${id}.json`),
        saved = await optional(path);
      if (saved) {
        const receipt = JSON.parse(saved),
          start = JSON.parse((await optional(`${path}.started`)) ?? "null");
        assert.deepEqual(receipt.identity, identity);
        assert.equal(receipt.outcomeHash, hash(json(receipt.outcome)));
        assert.deepEqual(start, { identity, startedAt: receipt.startedAt });
        consumed.set(id, receipt.outcome);
        return receipt.outcome;
      }
      assert.notEqual(values.mode, "verify", `Missing receipt: ${id}`);
      assert.equal(
        await optional(`${path}.started`),
        undefined,
        `Unknown prior provider outcome: ${id}; do not retry`,
      );
      const startedAt = new Date().toISOString();
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
      consumed.set(id, outcome);
      return outcome;
    }
    const fresh = new Map<string, Row["source"]>();
    let done = 0;
    await workers(built.inputs.cases, async (item, index) => {
      const arms = index % 2 ? [...JEV_SOURCE_ARMS].reverse() : JEV_SOURCE_ARMS;
      for (const arm of arms) {
        fresh.set(
          `${item.caseId}-${arm}`,
          await job(
            item.caseId,
            item.inputHash,
            `jev-${arm}`,
            [sourceKey],
            () => evaluateSourceSupport(item.input, arm),
          ),
        );
        console.log(
          json({
            stage: "jev",
            completed: ++done,
            total: 48,
            caseId: item.caseId,
            arm,
          }).trim(),
        );
      }
    });
    const rows: Row[] = [];
    const kimiShared = new Map<
      string,
      ReturnType<Parameters<typeof evaluateFixedCase>[2]["kimi"]>
    >();
    await workers(built.inputs.cases, async (item, index) => {
      const reference = built.reference.cases.find(
        (row) => row.caseId === item.caseId,
      );
      assert.ok(reference);
      for (const arm of index % 2
        ? [...JEV_SOURCE_ARMS].reverse()
        : JEV_SOURCE_ARMS) {
        const source = fresh.get(`${item.caseId}-${arm}`);
        assert.ok(source);
        let kimiReceipt: string | null = null;
        const result = await evaluateFixedCase(item.input, bands, {
          jev: async () =>
            source.status === "error"
              ? source
              : {
                  status: "success",
                  result: {
                    answers: {
                      ...frozenScores[item.caseId],
                      [sourceKey]: source.result.risk,
                    },
                    model: source.result.model,
                    usage: source.result.usage,
                  },
                },
          kimi: (clean, selected) => {
            assert.equal(hash(JSON.stringify(clean)), item.inputHash);
            const kind = `kimi-${selected.join("+")}`,
              sharedKey = `${item.inputHash}:${selected.join("+")}`;
            kimiReceipt = `${item.caseId}-${kind}.json`;
            let pending = kimiShared.get(sharedKey);
            if (!pending) {
              pending = job(item.caseId, item.inputHash, kind, selected, () =>
                evaluateWithKimi(clean, selected),
              );
              kimiShared.set(sharedKey, pending);
            }
            return pending;
          },
        });
        rows.push({ ...reference, ...result, arm, source, kimiReceipt });
        console.log(
          json({
            stage: "cascade",
            caseId: item.caseId,
            arm,
            final: result.finalDecision,
          }).trim(),
        );
      }
    });
    rows.sort(
      (a, b) => a.caseId.localeCompare(b.caseId) || a.arm.localeCompare(b.arm),
    );
    const summaries = Object.fromEntries(
      JEV_SOURCE_ARMS.map((arm) => [
        arm,
        summarize(rows.filter((row) => row.arm === arm)),
      ]),
    ) as Record<SourceSupportArm, ReturnType<typeof summarize>>;
    const costs = [...consumed].map(([id, outcome]) => {
      const value =
        outcome.status === "success"
          ? (outcome.result as {
              usage: { costUsd?: number | null; gateway?: { cost?: number } };
            })
          : null;
      const cost = id.includes("-jev-")
        ? value?.usage.gateway?.cost
        : (value?.usage.costUsd ??
          (outcome.status === "error"
            ? outcome.error.diagnostic?.usage.costUsd
            : undefined));
      return { id, cost: cost ?? null };
    });
    const actual = {
      jevCalls: costs.filter((row) => row.id.includes("-jev-")).length,
      kimiCalls: costs.filter((row) => row.id.includes("-kimi-")).length,
      reportedCostUsd: costs.reduce((sum, row) => sum + (row.cost ?? 0), 0),
      missingCostReceipts: costs
        .filter((row) => row.cost === null)
        .map((row) => row.id),
    };
    await immutable(join(output, "results.json"), {
      protocolHash,
      summaries,
      actual,
      cases: rows,
    });
    const report = render(rows, summaries, actual),
      old = await optional(join(output, "rapporto.md"));
    if (old !== undefined) assert.equal(old, report);
    else
      await writeFile(join(output, "rapporto.md"), report, {
        flag: "wx",
        mode: 0o600,
      });
    console.log(json({ summaries, actual }));
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
        : "Source comparison failed",
  );
  process.exitCode = 1;
});
