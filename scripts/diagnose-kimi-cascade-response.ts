import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadEnvConfig } from "@next/env";
import { z } from "zod";
import type { ConsolidationCriterion } from "../lib/maintenance/consolidation-rubric";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import {
  evaluateWithKimi,
  KIMI_EVALUATOR_SETTINGS,
} from "../lib/maintenance/kimi-evaluator";
import { runCascade } from "./evaluate-consolidation-cascade";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function shape(value: unknown) {
  return value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : typeof value;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function cost(value: unknown): number | null {
  const numeric =
    typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)
      ? Number(value)
      : value;
  return typeof numeric === "number" && Number.isFinite(numeric) && numeric >= 0
    ? numeric
    : null;
}

function safeEnum(value: unknown, allowed: string[]) {
  return typeof value === "string" && allowed.includes(value) ? value : "other";
}

/** Structural diagnostics only: no generated text, verdicts, reasoning or headers. */
export function inspectKimiStructure(
  payload: unknown,
  criteria: ConsolidationCriterion[],
) {
  const body = record(payload);
  const choices = body?.choices;
  const choice = Array.isArray(choices) ? record(choices[0]) : null;
  const message = record(choice?.message);
  const content = message?.content;
  let contentValidJson = false;
  let judgments: Record<string, unknown> | null = null;
  if (typeof content === "string") {
    try {
      const parsed: unknown = JSON.parse(content);
      contentValidJson = true;
      judgments = record(parsed);
    } catch {}
  }
  const keys = Object.keys(judgments ?? {});
  const usage = record(body?.usage);
  const gateway = record(record(body?.providerMetadata)?.gateway);
  return {
    bodyType: shape(payload),
    choicesType: shape(choices),
    choiceCount: Array.isArray(choices) ? choices.length : null,
    finishReason: safeEnum(choice?.finish_reason, [
      "stop",
      "length",
      "tool_calls",
      "function_call",
      "content_filter",
    ]),
    role: safeEnum(message?.role, ["assistant", "user", "system", "tool"]),
    refusalPresent: message?.refusal != null,
    functionCallPresent: message?.function_call != null,
    toolCallsPresent: message?.tool_calls != null,
    toolCallsType: shape(message?.tool_calls),
    toolCallCount: Array.isArray(message?.tool_calls)
      ? message.tool_calls.length
      : null,
    warningsType: shape(body?.warnings),
    warningsCount: Array.isArray(body?.warnings) ? body.warnings.length : null,
    contentType: shape(content),
    contentLength: typeof content === "string" ? content.length : null,
    contentNonempty: typeof content === "string" && content.trim().length > 0,
    contentValidJson,
    contentObject: judgments !== null,
    selectedKeyCount: keys.filter((key) =>
      criteria.includes(key as ConsolidationCriterion),
    ).length,
    unknownKeyCount: keys.filter(
      (key) => !criteria.includes(key as ConsolidationCriterion),
    ).length,
    criteria: Object.fromEntries(
      criteria.map((criterion) => {
        const judgment = record(judgments?.[criterion]);
        const fieldKeys = Object.keys(judgment ?? {});
        return [
          criterion,
          {
            present: Object.hasOwn(judgments ?? {}, criterion),
            object: judgment !== null,
            fieldCount: fieldKeys.length,
            allowedFieldKeys: fieldKeys.filter(
              (key) => key === "verdict" || key === "rationale",
            ),
            unknownFieldCount: fieldKeys.filter(
              (key) => key !== "verdict" && key !== "rationale",
            ).length,
            verdictValid:
              judgment?.verdict === "pass" ||
              judgment?.verdict === "fail" ||
              judgment?.verdict === "uncertain",
            rationaleType: shape(judgment?.rationale),
            rationaleLength:
              typeof judgment?.rationale === "string"
                ? judgment.rationale.length
                : null,
            rationaleNonempty:
              typeof judgment?.rationale === "string" &&
              judgment.rationale.trim().length > 0,
          },
        ];
      }),
    ),
    usage: {
      inputTokens: count(usage?.prompt_tokens),
      outputTokens: count(usage?.completion_tokens),
      totalTokens: count(usage?.total_tokens),
      reasoningTokens: count(
        record(usage?.completion_tokens_details)?.reasoning_tokens,
      ),
      cachedInputTokens: count(
        record(usage?.prompt_tokens_details)?.cached_tokens,
      ),
      costUsd: cost(gateway?.cost) ?? cost(usage?.cost),
    },
  };
}

const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
async function save(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

export async function diagnoseKimiCascade(options: {
  input: string;
  limit?: number;
}) {
  const limit = z
    .number()
    .int()
    .min(1)
    .max(3)
    .parse(options.limit ?? 3);
  const directory = resolve(options.input);
  // This refuses to run while the benchmark is active or incomplete and verifies
  // saved inputs, receipts and protocol. It makes no network calls.
  const summary = await runCascade(
    { input: directory, stage: "kimi" },
    { verifyOnly: true },
  );
  const failures = summary.byCase
    .flatMap((item) => [item.baseline, item.selective.receipt])
    .filter((receipt) => receipt?.outcome === "failed")
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, limit);
  if (failures.length === 0)
    throw new Error("No failed Kimi jobs to diagnose.");
  const casesBytes = await readFile(join(directory, "cases.json"));
  const cases = z
    .object({
      cases: z.array(
        z.object({
          caseId: z.string(),
          inputHash: z.string(),
          input: z.strictObject({
            before: z.unknown(),
            after: z.unknown(),
            evidence: z.unknown(),
            operation: z.unknown(),
          }),
        }),
      ),
    })
    .parse(JSON.parse(casesBytes.toString()));
  const jobs = failures.map((failure) => {
    const candidate = cases.cases.find(
      (item) => item.caseId === failure.caseId,
    );
    if (!candidate || candidate.inputHash !== failure.inputHash)
      throw new Error("Diagnostic case does not match original receipt.");
    return { receipt: failure, candidate };
  });
  const output = join(directory, "kimi-format-diagnostic");
  // Exclusive directory plus write-once started markers prevent a repeat run
  // after an ambiguous transport outcome. There is deliberately no resume.
  await mkdir(output, { mode: 0o700 });
  const spec = {
    createdAt: new Date().toISOString(),
    purpose:
      "Technical diagnosis only; excluded from benchmark quality metrics and receipts; supplemental cost only.",
    selection:
      "First failed Kimi jobs by immutable ID, maximum three; one new call each, no retries or resume.",
    protocolHash: summary.protocolHash,
    summaryHash: digest(await readFile(join(directory, "summary-kimi.json"))),
    casesHash: digest(casesBytes),
    adapterHash: digest(
      await readFile(resolve("lib/maintenance/kimi-evaluator.ts")),
    ),
    diagnosticCodeHash: digest(await readFile(fileURLToPath(import.meta.url))),
    settings: KIMI_EVALUATOR_SETTINGS,
    limit,
    jobs: jobs.map(({ receipt }) => ({
      id: receipt.id,
      caseId: receipt.caseId,
      inputHash: receipt.inputHash,
      criteria: receipt.criteria,
    })),
  };
  await save(join(output, "diagnostic-spec.json"), spec);
  const specHash = digest(JSON.stringify(spec));
  for (const { receipt, candidate } of jobs) {
    const startedAt = new Date().toISOString();
    await save(join(output, `${receipt.id}.started.json`), {
      specHash,
      id: receipt.id,
      startedAt,
    });
    let structuralMetadata: ReturnType<typeof inspectKimiStructure> | null =
      null;
    let httpStatus: number | null = null;
    let envelopeValidJson: boolean | null = null;
    let adapterSuccess = false;
    let safeError: {
      class: string;
      status: number | null;
      retryable: boolean;
    } | null = null;
    const started = performance.now();
    const observingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      httpStatus = response.status;
      if (response.status === 200) {
        try {
          const body: unknown = await response.clone().json();
          envelopeValidJson = true;
          structuralMetadata = inspectKimiStructure(body, receipt.criteria);
        } catch {
          envelopeValidJson = false;
        }
      }
      return response;
    };
    try {
      await evaluateWithKimi(candidate.input, receipt.criteria, {
        fetch: observingFetch,
      });
      adapterSuccess = true;
    } catch (error) {
      safeError =
        error instanceof GatewayRequestError
          ? {
              class:
                error.status !== null
                  ? "http"
                  : error.message.includes("invalid")
                    ? "invalid_response"
                    : "transport_or_nonretryable",
              status: error.status,
              retryable: error.retryable,
            }
          : { class: "unknown", status: null, retryable: false };
    }
    const result = {
      specHash,
      originalJobId: receipt.id,
      caseId: receipt.caseId,
      criteria: receipt.criteria,
      startedAt,
      completedAt: new Date().toISOString(),
      attempts: 1,
      latencyMs: performance.now() - started,
      adapterSuccess,
      error: safeError,
      httpStatus,
      envelopeValidJson,
      structuralMetadata,
    };
    await save(join(output, `${receipt.id}.json`), result);
    console.log(
      JSON.stringify({ id: receipt.id, adapterSuccess, httpStatus, output }),
    );
  }
  return { output, jobs: jobs.length };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: { input: { type: "string" }, limit: { type: "string" } },
  });
  if (!values.input) throw new Error("--input is required.");
  loadEnvConfig(process.cwd());
  diagnoseKimiCascade({
    input: values.input,
    limit: values.limit === undefined ? 3 : Number(values.limit),
  })
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error(
        "Diagnostic stopped; existing files are preserved. Inspect the write-once diagnostic records before any further action.",
      );
      process.exitCode = 1;
    });
}
