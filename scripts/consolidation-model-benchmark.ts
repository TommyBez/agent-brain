import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadEnvConfig } from "@next/env";
import { Client } from "pg";
import { fingerprint } from "../lib/canonical-json";
import { analyzeTask } from "../lib/maintenance/consolidator/analysis";
import { verificationThreshold } from "../lib/maintenance/consolidator/decision-policy";
import { parseEvaluation } from "../lib/maintenance/consolidator/jev";
import { createAnalysisTasks } from "../lib/maintenance/consolidator/snapshot";
import type {
  Answer,
  Evaluation,
  EvaluationRequest,
  Snapshot,
} from "../lib/maintenance/consolidator/types";

// Read-only, opt-in research harness. Dataset preparation never calls a model;
// live runs never access the database or modify operational records.
const MODELS = [
  "typesafe-ai/jev-1.14.0",
  "perplexity/pplx-decider-v1.2",
] as const;
const DIRECTORY = resolve("docs/benchmarks/2026-10-31-consolidation-models");
type Case = {
  id: string;
  cohort:
    | "synthetic"
    | "real-screening"
    | "real-choice"
    | "real-verification"
    | "real-capacity";
  request: EvaluationRequest;
  expected?: Record<string, boolean | string>;
  source?: { runId: string; recordKey: string; judgmentIndex?: number };
};
type Dataset = {
  version: string;
  createdAt: string;
  cutoff: string;
  cases: Case[];
};
type Result = {
  id: string;
  cohort: Case["cohort"];
  model: string;
  repeat: number;
  milliseconds: number;
  status: "ok" | "http_error" | "invalid_response" | "transport_error";
  code?: string;
  answers?: Record<string, Answer>;
  cost: number | null;
  reservedUsd: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
};
const { values } = parseArgs({
  options: {
    prepare: { type: "boolean" },
    "dry-run": { type: "boolean" },
    "synthetic-only": { type: "boolean" },
    "real-only": { type: "boolean" },
    summarize: { type: "boolean" },
    dataset: {
      type: "string",
      default: "/tmp/consolidation-model-benchmark-private/dataset.json",
    },
    out: {
      type: "string",
      default: "/tmp/consolidation-model-benchmark-private",
    },
    owner: { type: "string" },
    repeats: { type: "string", default: "2" },
    budget: { type: "string", default: "5" },
  },
});

async function save(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
async function synthetic(): Promise<Case[]> {
  return JSON.parse(
    await readFile(resolve(DIRECTORY, "synthetic.json"), "utf8"),
  );
}

async function prepare() {
  if (!values.owner)
    throw new Error("--owner is required for read-only preparation");
  loadEnvConfig(process.cwd());
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const window = `r.owner_id=$1 AND j.kind='consolidation' AND j.run_date>='2026-10-25' AND j.run_date<='2026-10-31'`;
    const traces = await client.query(
      `SELECT r.run_id,r.record_key,r.payload->'judgments' AS judgments FROM brain_consolidation_records r JOIN brain_jobs j ON j.owner_id=r.owner_id AND j.workflow_run_id=r.run_id WHERE ${window} AND r.record_key LIKE 'verification:%' AND jsonb_array_length(coalesce(r.payload->'judgments','[]'))>0 ORDER BY r.record_key`,
      [values.owner],
    );
    const cases = await synthetic();
    // Deterministic evenly spaced selection, fixed before either live result.
    for (let i = 0; i < 4; i++) {
      const trace = traces.rows[Math.floor((i * traces.rows.length) / 4)];
      const judgment = trace.judgments[0];
      cases.push({
        id: `real-verification-${i + 1}`,
        cohort: "real-verification",
        request: { state: judgment.state, questions: judgment.questions },
        source: {
          runId: trace.run_id,
          recordKey: trace.record_key,
          judgmentIndex: 0,
        },
      });
    }
    // Project only the selected judgments in PostgreSQL, not the whole corpus.
    for (const cohort of ["real-screening", "real-choice"] as const) {
      const result = await client.query(
        `SELECT r.run_id,r.record_key,q.ordinality-1 AS index,q.value->'state' AS state,q.value->'questions' AS questions FROM brain_consolidation_records r JOIN brain_jobs j ON j.owner_id=r.owner_id AND j.workflow_run_id=r.run_id CROSS JOIN LATERAL jsonb_array_elements(r.payload->'judgments') WITH ORDINALITY q(value,ordinality) WHERE ${window} AND r.record_key LIKE 'analysis:%' AND ${cohort === "real-screening" ? "q.value->'questions' ? 'duplicate'" : "EXISTS (SELECT 1 FROM jsonb_each(q.value->'questions') z WHERE z.value->>'type'='choice')"} ORDER BY r.record_key,q.ordinality LIMIT 4`,
        [values.owner],
      );
      result.rows.forEach((r, i) => {
        cases.push({
          id: `${cohort}-${i + 1}`,
          cohort,
          request: { state: r.state, questions: r.questions },
          source: {
            runId: r.run_id,
            recordKey: r.record_key,
            judgmentIndex: Number(r.index),
          },
        });
      });
    }
    const failed = await client.query(
      `SELECT r.run_id,r.record_key,r.payload FROM brain_consolidation_records r JOIN brain_jobs j ON j.owner_id=r.owner_id AND j.workflow_run_id=r.run_id WHERE ${window} AND j.run_date='2026-10-30' AND r.record_key LIKE 'task-error:%' AND r.payload#>>'{error,code}'='max_tokens_exceeded' AND r.payload->>'stage'='analysis' ORDER BY r.record_key LIMIT 4`,
      [values.owner],
    );
    const snapshotResult = await client.query(
      `SELECT payload FROM brain_consolidation_records WHERE owner_id=$1 AND run_id=$2 AND record_key LIKE 'snapshot:%'`,
      [values.owner, failed.rows[0].run_id],
    );
    const snapshot = snapshotResult.rows[0].payload as Snapshot;
    const allTasks = createAnalysisTasks(snapshot);
    for (const [index, row] of failed.rows.entries()) {
      const task = allTasks.find(
        (t) =>
          JSON.stringify(t.pageIds) === JSON.stringify(row.payload.pageIds),
      );
      if (!task) throw new Error("Failed task not found in immutable snapshot");
      let captured: EvaluationRequest | undefined;
      const stop = new Error("benchmark request captured");
      try {
        await analyzeTask(snapshot, task, async (request) => {
          const key = `evaluation:${fingerprint({ model: MODELS[0], request })}`;
          const found = await client.query(
            `SELECT payload FROM brain_consolidation_records WHERE owner_id=$1 AND record_key=$2 AND created_at<'2026-10-31' ORDER BY created_at DESC LIMIT 1`,
            [values.owner, key],
          );
          if (found.rows[0]) return found.rows[0].payload as Evaluation;
          captured = request;
          throw stop;
        });
      } catch (error) {
        if (error !== stop) throw error;
      }
      if (!captured)
        throw new Error("Could not reconstruct missing capacity request");
      cases.push({
        id: `real-capacity-${index + 1}`,
        cohort: "real-capacity",
        request: captured,
        source: { runId: row.run_id, recordKey: row.record_key },
      });
    }
    const dataset: Dataset = {
      version: "consolidation-models-v1",
      createdAt: new Date().toISOString(),
      cutoff: "2026-10-31T23:59:59Z",
      cases,
    };
    const out = resolve(values.out as string);
    await mkdir(out, { recursive: true, mode: 0o700 });
    await save(resolve(values.dataset as string), dataset);
    await save(
      resolve(out, "blind-real-review.json"),
      cases.filter((c) => c.cohort === "real-verification"),
    );
    await mkdir(DIRECTORY, { recursive: true });
    await save(
      resolve(DIRECTORY, "synthetic.json"),
      cases.filter((c) => c.cohort === "synthetic"),
    );
    await save(resolve(DIRECTORY, "manifest.json"), {
      ...dataset,
      cases: cases.map(({ request, expected, ...c }) => ({
        ...c,
        expected,
        requestHash: fingerprint(request),
        characters: JSON.stringify(request).length,
        questionCount: Object.keys(request.questions).length,
      })),
    });
    console.log(
      JSON.stringify({
        prepared: cases.length,
        fingerprint: fingerprint(dataset),
        cohorts: countBy(cases, (c) => c.cohort),
      }),
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}

function countBy<T>(items: T[], key: (item: T) => string) {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}
function median(sorted: number[]) {
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}
function decision(answer: Answer | undefined, key: string) {
  if (!answer) return null;
  if (answer.type === "boolean")
    return answer.probability >= verificationThreshold(key);
  return answer.probabilities[answer.choice] >= 0.8
    ? answer.choice
    : "uncertain";
}
function safeCode(raw: unknown, status: number) {
  const text = JSON.stringify(raw);
  return text.includes("max_tokens_exceeded")
    ? "max_tokens_exceeded"
    : `http_${status}`;
}

async function run() {
  const dataset: Dataset = values["synthetic-only"]
    ? {
        version: "consolidation-models-synthetic-v1",
        createdAt: "2026-10-31",
        cutoff: "synthetic",
        cases: await synthetic(),
      }
    : JSON.parse(await readFile(resolve(values.dataset as string), "utf8"));
  if (values["synthetic-only"] && values["real-only"])
    throw new Error("Choose one cohort filter");
  if (values["real-only"])
    dataset.cases = dataset.cases.filter((item) => item.cohort !== "synthetic");
  if (values["dry-run"]) {
    console.log(
      JSON.stringify(
        {
          fingerprint: fingerprint(dataset),
          cases: dataset.cases.length,
          cohorts: countBy(dataset.cases, (c) => c.cohort),
          questions: dataset.cases.reduce(
            (n, c) => n + Object.keys(c.request.questions).length,
            0,
          ),
        },
        null,
        2,
      ),
    );
    return;
  }
  loadEnvConfig(process.cwd());
  if (!process.env.AI_GATEWAY_API_KEY)
    throw new Error("AI_GATEWAY_API_KEY missing");
  const repeats = Number(values.repeats),
    budget = Number(values.budget);
  if (
    !Number.isSafeInteger(repeats) ||
    repeats < 1 ||
    repeats > 3 ||
    !Number.isFinite(budget) ||
    budget <= 0 ||
    budget > 5
  )
    throw new Error("Invalid repeat count or budget (maximum USD 5)");
  const catalog = await (
    await fetch("https://ai-gateway.vercel.sh/v1/models", {
      signal: AbortSignal.timeout(15000),
    })
  ).json();
  const models = MODELS.map((id) => {
    const model = catalog.data.find((m: { id: string }) => m.id === id);
    if (
      !model ||
      model.type !== "evaluation" ||
      Number(model.pricing.output) !== 0
    )
      throw new Error(`Unexpected model contract: ${id}`);
    return model;
  });
  const out = resolve(values.out as string);
  await mkdir(out, { recursive: true, mode: 0o700 });
  await save(resolve(out, "catalog.json"), models);
  const results: Result[] = [];
  let reserved = 0;
  // Alternate model order between cases/repeats to reduce ordering bias.
  for (let repeat = 0; repeat < repeats; repeat++)
    for (const [index, item] of dataset.cases.entries()) {
      const order = (index + repeat) % 2 ? [...models].reverse() : models;
      for (const model of order) {
        const serialized = JSON.stringify({ model: model.id, ...item.request });
        // Reserve a deliberately pessimistic ceiling per physical call; it remains
        // reserved on errors. At least 2x full serialized bytes per question plus
        // 8192 tokens overhead per question, with a 10-cent floor.
        const q = Object.keys(item.request.questions).length;
        const ceiling = Math.max(
          0.1,
          (Buffer.byteLength(serialized) * 2 + 8192) *
            q *
            Number(model.pricing.input),
        );
        if (reserved + ceiling > budget)
          throw new Error("Conservative budget exhausted before next call");
        reserved += ceiling;
        const started = performance.now();
        let result: Result;
        try {
          const response = await fetch(
            "https://ai-gateway.vercel.sh/v1/evaluate",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: serialized,
              signal: AbortSignal.timeout(60000),
            },
          );
          const raw = await response.json();
          const costValue = raw.providerMetadata?.gateway?.cost;
          const cost =
            Number.isFinite(Number(costValue)) && costValue != null
              ? Number(costValue)
              : null;
          result = {
            id: item.id,
            cohort: item.cohort,
            model: model.id,
            repeat,
            milliseconds: performance.now() - started,
            status: "http_error",
            code: safeCode(raw, response.status),
            cost,
            reservedUsd: ceiling,
          };
          if (response.ok) {
            try {
              const evaluated = parseEvaluation(item.request, raw);
              result = {
                ...result,
                status: "ok",
                code: undefined,
                answers: evaluated.answers,
                inputTokens: evaluated.inputTokens,
                outputTokens: evaluated.outputTokens,
              };
            } catch (error) {
              result.status = "invalid_response";
              result.code =
                error instanceof Error && "reason" in error
                  ? String(error.reason)
                  : "schema";
            }
          }
          // Raw answers can echo choice identifiers, but prompts and credentials are never written here.
          await save(
            resolve(
              out,
              `raw-${item.id}-${models.indexOf(model)}-${repeat}.json`,
            ),
            raw,
          );
          if (cost !== null && cost > ceiling) {
            results.push(result);
            await save(resolve(out, "results.json"), results);
            throw new Error("Provider cost exceeded reservation; stopped");
          }
          if (cost !== null) reserved -= ceiling - cost;
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.startsWith("Provider cost")
          )
            throw error;
          result = {
            id: item.id,
            cohort: item.cohort,
            model: model.id,
            repeat,
            milliseconds: performance.now() - started,
            status: "transport_error",
            code:
              error instanceof Error && error.name === "TimeoutError"
                ? "timeout"
                : "transport",
            cost: null,
            reservedUsd: ceiling,
          };
        }
        results.push(result);
        await save(resolve(out, "results.json"), results);
        console.log(
          `${repeat + 1}/${repeats} ${item.id} ${model.id}: ${result.status} ${result.code ?? ""} ${(result.milliseconds / 1000).toFixed(2)}s`,
        );
      }
    }
  const metrics = models.map((model) => {
    const own = results.filter((r) => r.model === model.id);
    const times = own
      .filter((r) => r.status === "ok")
      .map((r) => r.milliseconds)
      .sort((a, b) => a - b);
    let correct = 0,
      labels = 0,
      falseAccepts = 0,
      negativeLabels = 0;
    const misses: {
      id: string;
      repeat: number;
      expected: boolean | string;
      predicted: unknown;
    }[] = [];
    for (const result of own) {
      const item = dataset.cases.find((c) => c.id === result.id);
      if (!item) throw new Error("Result has no dataset case");
      for (const [key, expected] of Object.entries(item.expected ?? {})) {
        labels++;
        if (expected === false) negativeLabels++;
        const predicted = decision(result.answers?.[key], key);
        if (predicted === expected) correct++;
        else
          misses.push({
            id: result.id,
            repeat: result.repeat,
            expected,
            predicted,
          });
        if (expected === false && predicted === true) falseAccepts++;
      }
    }
    return {
      model: model.id,
      requests: own.length,
      statuses: countBy(own, (r) => `${r.status}:${r.code ?? ""}`),
      byCohort: Object.fromEntries(
        [...new Set(own.map((r) => r.cohort))].map((cohort) => [
          cohort,
          countBy(
            own.filter((r) => r.cohort === cohort),
            (r) => r.status,
          ),
        ]),
      ),
      medianSuccessMs: median(times),
      p95SuccessMs: times[Math.ceil(times.length * 0.95) - 1] ?? null,
      knownCostUsd: own.reduce((n, r) => n + (r.cost ?? 0), 0),
      unknownCostRequests: own.filter((r) => r.cost === null).length,
      labeled: {
        labels,
        correct,
        accuracy: correct / labels,
        falseAccepts,
        negativeLabels,
        misses,
      },
    };
  });
  const report = {
    runAt: new Date().toISOString(),
    datasetHash: fingerprint(dataset),
    datasetVersion: dataset.version,
    protocol: "identical-requests-no-retry-no-fallback",
    thresholds: { objective: 0.8, integrity: 0.65, choice: 0.8 },
    repeats,
    budgetUsd: budget,
    retainedReservationUsd: reserved,
    metrics,
    results,
  };
  await mkdir(DIRECTORY, { recursive: true });
  await save(
    resolve(
      DIRECTORY,
      values["synthetic-only"]
        ? "report-synthetic.json"
        : values["real-only"]
          ? "report-real.json"
          : "report.json",
    ),
    report,
  );
  console.log(JSON.stringify(metrics, null, 2));
}

async function summarize() {
  const syntheticReport = JSON.parse(
    await readFile(resolve(DIRECTORY, "report-synthetic.json"), "utf8"),
  );
  const realReport = JSON.parse(
    await readFile(resolve(DIRECTORY, "report-real.json"), "utf8"),
  );
  const gold = JSON.parse(
    await readFile(resolve(DIRECTORY, "real-labels.json"), "utf8"),
  ) as {
    cases: {
      id: string;
      value: boolean | null;
      hardScoreEligible: boolean;
      confidence: string;
    }[];
  };
  const real = realReport.results as Result[];
  const syntheticCases = await synthetic();
  const common = new Set(
    real
      .filter(
        (row) =>
          row.status === "ok" &&
          MODELS.every((model) =>
            real.some(
              (other) =>
                other.id === row.id &&
                other.model === model &&
                other.status === "ok",
            ),
          ),
      )
      .map((row) => row.id),
  );
  const models = MODELS.map((model) => {
    const ownReal = real.filter((row) => row.model === model);
    const booleanErrors: number[] = [];
    for (const row of syntheticReport.results as Result[]) {
      if (row.model !== model) continue;
      const item = syntheticCases.find((candidate) => candidate.id === row.id);
      for (const [key, expected] of Object.entries(item?.expected ?? {})) {
        const answer = row.answers?.[key];
        if (typeof expected === "boolean" && answer?.type === "boolean")
          booleanErrors.push((answer.probability - Number(expected)) ** 2);
      }
    }
    const matched = real.filter(
      (row) => row.model === model && common.has(row.id),
    );
    const times = matched.map((row) => row.milliseconds).sort((a, b) => a - b);
    const labels = gold.cases.map((item) => {
      const result = real.find(
        (row) => row.id === item.id && row.model === model,
      );
      const answer = result?.answers?.objective;
      const probability =
        answer?.type === "boolean" ? answer.probability : null;
      const acceptsObjective = probability === null ? null : probability >= 0.8;
      return {
        ...item,
        probability,
        acceptsObjective,
        correct: item.hardScoreEligible
          ? acceptsObjective === item.value
          : null,
      };
    });
    const scoreable = labels.filter((item) => item.hardScoreEligible);
    return {
      model,
      realRequests: ownReal.length,
      realSchemaValid: ownReal.filter((row) => row.status === "ok").length,
      realUnknownCostRequests: ownReal.filter((row) => row.cost === null)
        .length,
      realKnownCostUsd: ownReal.reduce((sum, row) => sum + (row.cost ?? 0), 0),
      matchedRealRequests: matched.length,
      matchedRealCostUsd: matched.reduce(
        (sum, row) => sum + (row.cost ?? 0),
        0,
      ),
      matchedRealMedianMs: median(times),
      syntheticBooleanExposures: booleanErrors.length,
      syntheticBooleanBrier: booleanErrors.length
        ? booleanErrors.reduce((sum, error) => sum + error, 0) /
          booleanErrors.length
        : null,
      blindObjective: {
        labels,
        scoreable: scoreable.length,
        correct: scoreable.filter((item) => item.correct).length,
        falseAccepts: scoreable.filter(
          (item) => item.value === false && item.acceptsObjective === true,
        ).length,
        missedAccepts: scoreable.filter(
          (item) => item.value === true && item.acceptsObjective === false,
        ).length,
      },
    };
  });
  await save(resolve(DIRECTORY, "comparison.json"), {
    syntheticDatasetHash: syntheticReport.datasetHash,
    realDatasetHash: realReport.datasetHash,
    syntheticRequests: syntheticReport.results.length,
    realRequests: real.length,
    totalKnownCostUsd: [...syntheticReport.results, ...real].reduce(
      (sum, row) => sum + (row.cost ?? 0),
      0,
    ),
    totalRetainedReservationUsd:
      syntheticReport.retainedReservationUsd +
      realReport.retainedReservationUsd,
    models,
    interpretation:
      "Two hard-score-eligible real labels do not rank models. Objective acceptance alone does not authorize applying changes. No model switch is justified by this benchmark alone.",
  });
  console.log(JSON.stringify(models, null, 2));
}

(values.summarize ? summarize() : values.prepare ? prepare() : run()).catch(
  (error) => {
    console.error(error instanceof Error ? error.message : "Benchmark failed");
    process.exitCode = 1;
  },
);
