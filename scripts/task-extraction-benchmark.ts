import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fingerprint } from "../lib/canonical-json";
import { EDITOR_MODEL } from "../lib/maintenance/consolidator/budget";
import { evaluateJev, JEV_MODEL } from "../lib/maintenance/consolidator/jev";
import type { EvaluationRequest } from "../lib/maintenance/consolidator/types";
import { type GatewayCall, gatewayRequest } from "../lib/maintenance/gateway";
import {
  benchmarkMetrics,
  benchmarkPage,
  type CaseScore,
  extractionBenchmarkSchema,
  type PredictedItem,
  scoreCase,
} from "../lib/maintenance/task-keeper/benchmark";
import {
  extractCommitments,
  extractionContext,
  extractionRequestBody,
} from "../lib/maintenance/task-keeper/extract";
import { TASK_KEEPER_THRESHOLDS } from "../lib/maintenance/task-keeper/policy";
import { TASK_KEEPER_POLICY } from "../lib/maintenance/task-keeper/prompts";
import { screenPage } from "../lib/maintenance/task-keeper/screen";
import {
  buildKeeperSnapshot,
  excerptOf,
} from "../lib/maintenance/task-keeper/snapshot";
import { verifyItem } from "../lib/maintenance/task-keeper/verify";

// Task keeper extraction benchmark (§8.5, release criterion 11). Each
// synthetic page goes through the production pipeline: Jev screening and
// passage localization, DeepSeek extraction, Jev verification. Dedupe needs a
// database and is covered by the integration tests. It reads no env file and
// touches no database: pass AI_GATEWAY_API_KEY explicitly.
//
//   node --import tsx scripts/task-extraction-benchmark.ts --dry-run
//   AI_GATEWAY_API_KEY=… node --import tsx scripts/task-extraction-benchmark.ts --out <dir>

const DIRECTORY = resolve(
  import.meta.dirname,
  "../docs/benchmarks/2026-10-21-task-extraction",
);
/** Fallback rates of budget.ts, in nano-USD per token. */
const RATES = { jevInput: 42, editorInput: 150, editorOutput: 600 };

function meteredGateway() {
  const usage = {
    jevRequests: 0,
    jevInputTokens: 0,
    editorRequests: 0,
    editorInputTokens: 0,
    editorOutputTokens: 0,
    unknownUsage: 0,
  };
  const send = (async (path: Parameters<GatewayCall>[0], body: unknown) => {
    const response = (await gatewayRequest(path, body)) as Record<
      string,
      unknown
    >;
    const raw = (response.usage ?? {}) as Record<string, unknown>;
    if (path === "evaluate") {
      usage.jevRequests++;
      if (typeof raw.inputTokens === "number")
        usage.jevInputTokens += raw.inputTokens;
      else usage.unknownUsage++;
    } else {
      usage.editorRequests++;
      if (typeof raw.prompt_tokens === "number")
        usage.editorInputTokens += raw.prompt_tokens;
      else usage.unknownUsage++;
      if (typeof raw.completion_tokens === "number")
        usage.editorOutputTokens += raw.completion_tokens;
    }
    return response;
  }) as GatewayCall;
  return { send, usage };
}

async function main() {
  const { values } = parseArgs({
    options: {
      dataset: { type: "string", default: resolve(DIRECTORY, "dataset.json") },
      out: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      limit: { type: "string" },
    },
  });
  const dataset = extractionBenchmarkSchema.parse(
    JSON.parse(await readFile(values.dataset as string, "utf8")),
  );
  const cases = dataset.cases.slice(
    0,
    values.limit ? Number(values.limit) : dataset.cases.length,
  );
  const snapshots = cases.map((item) =>
    buildKeeperSnapshot(benchmarkPage(item), []),
  );
  const header = {
    dataset: dataset.id,
    datasetFingerprint: fingerprint(dataset),
    jevModel: JEV_MODEL,
    extractionModel: EDITOR_MODEL,
    policyVersion: TASK_KEEPER_POLICY.version,
    thresholds: TASK_KEEPER_THRESHOLDS,
    cases: cases.length,
    expectedItems: cases.reduce(
      (total, item) => total + item.expected.length,
      0,
    ),
  };
  if (values["dry-run"]) {
    // Every passage as a candidate: the largest extraction request per page.
    const bodies = snapshots.map((snapshot) =>
      extractionRequestBody(
        extractionContext(
          snapshot,
          snapshot.units.map((_, index) => index),
        ).content,
      ),
    );
    console.log(
      JSON.stringify(
        {
          ...header,
          dryRun: true,
          units: snapshots.reduce(
            (total, item) => total + item.units.length,
            0,
          ),
          maxExtractionCharacters: Math.max(
            ...bodies.map((body) => JSON.stringify(body).length),
          ),
          categories: Object.fromEntries(
            Object.keys(dataset.categories).map((category) => [
              category,
              cases.filter((item) => item.category === category).length,
            ]),
          ),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!process.env.AI_GATEWAY_API_KEY)
    throw new Error(
      "Set AI_GATEWAY_API_KEY explicitly for a live run, or pass --dry-run.",
    );
  const { send, usage } = meteredGateway();
  const evaluate = (request: EvaluationRequest) => evaluateJev(request, send);
  const scores: CaseScore[] = [];
  const predictions: {
    id: string;
    screen: string;
    items: (PredictedItem & { verification: string })[];
  }[] = [];
  const errors: { id: string; error: string }[] = [];
  for (const [index, item] of cases.entries()) {
    const snapshot = snapshots[index];
    try {
      const screened = await screenPage(snapshot, evaluate);
      const found: (PredictedItem & { verification: string })[] = [];
      if (screened.status === "candidates") {
        const extracted = await extractCommitments(
          snapshot,
          screened.candidates,
          send,
        );
        for (const candidate of extracted) {
          const verification = await verifyItem(snapshot, candidate, evaluate);
          const verified =
            verification.status === "accepted" ? verification.item : null;
          found.push({
            title: candidate.title,
            excerpt: excerptOf(snapshot, candidate.passages).text,
            actorNames: verified?.actorNames ?? candidate.actorNames,
            dueKind: verified?.dueKind ?? "unset",
            dueDate: verified?.dueDate ?? null,
            dueText: verified?.dueText ?? null,
            verification: verification.status,
          });
        }
      }
      const accepted = found.filter(
        (entry) => entry.verification === "accepted",
      );
      scores.push(scoreCase(item, accepted));
      predictions.push({ id: item.id, screen: screened.status, items: found });
      console.log(
        `${item.id}: ${screened.status}, ${accepted.length}/${item.expected.length} items`,
      );
    } catch (error) {
      errors.push({
        id: item.id,
        error: error instanceof Error ? error.message : "Evaluation failed",
      });
      console.error(`${item.id}: evaluation failed`);
    }
  }
  const metrics = benchmarkMetrics(scores);
  const report = {
    ...header,
    runAt: new Date().toISOString(),
    metrics,
    usage: {
      ...usage,
      estimatedNanoUsd:
        usage.jevInputTokens * RATES.jevInput +
        usage.editorInputTokens * RATES.editorInput +
        usage.editorOutputTokens * RATES.editorOutput,
    },
    errors,
    scores,
    predictions,
  };
  const out = resolve((values.out as string | undefined) ?? DIRECTORY);
  await mkdir(out, { recursive: true });
  await writeFile(
    resolve(out, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const percent = (value: number | null) =>
    value === null ? "n/d" : `${(value * 100).toFixed(2).replace(".", ",")}%`;
  const markdown = [
    `# Estrazione del gestore dei task — ${header.dataset}`,
    "",
    `Modelli \`${header.jevModel}\` e \`${header.extractionModel}\`, politica \`${header.policyVersion}\`, ${header.cases} casi, ${header.expectedItems} impegni attesi; errori: ${errors.length}.`,
    "",
    "| Metrica | Valore |",
    "|---|---:|",
    `| Precisione (impegni) | ${percent(metrics.items.precision)} |`,
    `| Recall (impegni) | ${percent(metrics.items.recall)} |`,
    `| F1 | ${percent(metrics.items.f1)} |`,
    `| Casi esatti | ${percent(metrics.caseAccuracy)} |`,
    `| Task inventati (casi negativi) | ${metrics.inventedTasks} |`,
    `| Persone inventate | ${metrics.inventedActors} |`,
    `| Date sbagliate | ${metrics.wrongDates} |`,
    `| Assegnatario corretto | ${percent(metrics.fields.actor)} |`,
    `| Tipo di scadenza corretto | ${percent(metrics.fields.dueKind)} |`,
    `| Data corretta | ${percent(metrics.fields.dueDate)} |`,
    "",
    "| Categoria | Casi | Accuratezza |",
    "|---|---:|---:|",
    ...Object.entries(metrics.categories).map(
      ([category, value]) =>
        `| ${category} | ${value.cases} | ${percent(value.accuracy)} |`,
    ),
    "",
  ].join("\n");
  await writeFile(resolve(out, "report.md"), markdown);
  console.log(markdown);
  if (errors.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "task extraction benchmark failed",
  );
  process.exitCode = 1;
});
