import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fingerprint } from "../lib/canonical-json";
import { evaluateJev, JEV_MODEL } from "../lib/maintenance/consolidator/jev";
import { gatewayRequest } from "../lib/maintenance/gateway";
import {
  benchmarkMetrics,
  benchmarkRequest,
  benchmarkSchema,
  type CasePrediction,
  predictedRole,
} from "../lib/maintenance/task-links/benchmark";
import {
  resolveTaskPromptProfile,
  TASK_LINK_POLICY,
} from "../lib/maintenance/task-links/policy";
import { readJudgments } from "../lib/maintenance/task-links/questions";

// task_relevance benchmark runner (§8.3, release criterion 11). It sends the
// production request of each synthetic scenario to Jev through the existing
// gateway code and reports precision and recall per role. It reads no env
// file and touches no database: pass AI_GATEWAY_API_KEY explicitly.
//
//   node --import tsx scripts/task-relevance-benchmark.ts --dry-run
//   AI_GATEWAY_API_KEY=… node --import tsx scripts/task-relevance-benchmark.ts --out <dir>

const DIRECTORY = resolve(
  import.meta.dirname,
  "../docs/benchmarks/2026-10-21-task-relevance",
);
/** Fallback rate of budget.ts for Jev input tokens, in nano-USD. */
const JEV_NANO_PER_INPUT_TOKEN = 42;

async function main() {
  const { values } = parseArgs({
    options: {
      dataset: { type: "string", default: resolve(DIRECTORY, "dataset.json") },
      out: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      limit: { type: "string" },
    },
  });
  const dataset = benchmarkSchema.parse(
    JSON.parse(await readFile(values.dataset as string, "utf8")),
  );
  const limit = values.limit ? Number(values.limit) : dataset.scenarios.length;
  const scenarios = dataset.scenarios.slice(0, limit);
  const profile = resolveTaskPromptProfile();
  const requests = scenarios.map((scenario) => benchmarkRequest(scenario));
  const header = {
    dataset: dataset.id,
    datasetFingerprint: fingerprint(dataset),
    model: JEV_MODEL,
    policyVersion: TASK_LINK_POLICY.version,
    promptProfile: profile.id,
    thresholds: {
      relevant: TASK_LINK_POLICY.relevant,
      governs: TASK_LINK_POLICY.governs,
      stakeholder: TASK_LINK_POLICY.stakeholder,
    },
    scenarios: scenarios.length,
    cases: scenarios.reduce(
      (total, scenario) => total + scenario.pages.length,
      0,
    ),
  };
  if (values["dry-run"]) {
    console.log(
      JSON.stringify(
        {
          ...header,
          dryRun: true,
          questions: requests.reduce(
            (total, request) => total + Object.keys(request.questions).length,
            0,
          ),
          maxRequestCharacters: Math.max(
            ...requests.map((request) => JSON.stringify(request).length),
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
  const predictions: CasePrediction[] = [];
  const errors: { scenario: string; error: string }[] = [];
  let inputTokens = 0;
  let unknownUsage = 0;
  for (const [index, scenario] of scenarios.entries()) {
    try {
      const evaluation = await evaluateJev(requests[index], gatewayRequest);
      if (evaluation.inputTokens === null) unknownUsage++;
      else inputTokens += evaluation.inputTokens;
      const judgments = readJudgments(
        scenario.pages.map((item) => item.page),
        evaluation.answers,
      );
      scenario.pages.forEach((item, position) => {
        predictions.push({
          id: item.id,
          category: item.category,
          expected: item.expected,
          predicted: predictedRole(judgments[position]),
          judgment: judgments[position],
        });
      });
      console.log(`${scenario.id}: ${scenario.pages.length} cases evaluated`);
    } catch (error) {
      errors.push({
        scenario: scenario.id,
        error: error instanceof Error ? error.message : "Evaluation failed",
      });
      console.error(`${scenario.id}: evaluation failed`);
    }
  }
  const report = {
    ...header,
    runAt: new Date().toISOString(),
    metrics: benchmarkMetrics(predictions),
    usage: {
      requests: scenarios.length,
      inputTokens,
      unknownUsage,
      estimatedNanoUsd: inputTokens * JEV_NANO_PER_INPUT_TOKEN,
    },
    errors,
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
  const rows = Object.entries(report.metrics.roles).map(
    ([role, metrics]) =>
      `| ${role} | ${percent(metrics.precision)} | ${percent(metrics.recall)} | ${metrics.truePositives} | ${metrics.falsePositives} | ${metrics.falseNegatives} |`,
  );
  const markdown = [
    `# task_relevance — ${header.dataset}`,
    "",
    `Modello \`${header.model}\`, politica \`${header.policyVersion}\`, ${header.cases} casi in ${header.scenarios} richieste; errori: ${errors.length}.`,
    "",
    "| Ruolo | Precisione | Recall | VP | FP | FN |",
    "|---|---:|---:|---:|---:|---:|",
    ...rows,
    `| collegamento (qualsiasi ruolo) | ${percent(report.metrics.linkDetection.precision)} | ${percent(report.metrics.linkDetection.recall)} | ${report.metrics.linkDetection.truePositives} | ${report.metrics.linkDetection.falsePositives} | ${report.metrics.linkDetection.falseNegatives} |`,
    "",
    "| Categoria | Casi | Accuratezza |",
    "|---|---:|---:|",
    ...Object.entries(report.metrics.categories).map(
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
    error instanceof Error ? error.message : "task_relevance benchmark failed",
  );
  process.exitCode = 1;
});
