import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import nextEnv, { loadEnvConfig } from "@next/env";
import { analyzeTask } from "../lib/maintenance/consolidator/analysis";
import {
  draftChanges,
  materializeDraft,
} from "../lib/maintenance/consolidator/editor";
import { evaluateJev } from "../lib/maintenance/consolidator/jev";
import { planOperations } from "../lib/maintenance/consolidator/planner";
import {
  buildSnapshot,
  createAnalysisTasks,
} from "../lib/maintenance/consolidator/snapshot";
import {
  type AnalysisResult,
  type ChangeSet,
  type OperationPlan,
  POLICY,
  type Verification,
} from "../lib/maintenance/consolidator/types";
import { verifyChangeSet } from "../lib/maintenance/consolidator/verifier";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import {
  type ConsolidationFixture,
  consolidationFixtures,
  fixtureGroundTruthPlan,
} from "../tests/helpers/consolidation-fixtures";

type Call = {
  caseId: string;
  phase: string;
  path: string;
  elapsedMs: number;
  status?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  responseShape?: unknown;
  error?: string;
};
type CaseResult = {
  id: string;
  description: string;
  expected: ConsolidationFixture["expected"];
  analysis?: AnalysisResult;
  plans?: OperationPlan[];
  selectedPlan?: OperationPlan;
  changeSet?: ChangeSet;
  verification?: Verification;
  outcome: string;
  mode: "end_to_end" | "fixture_ground_truth_stages";
  expectationMet?: boolean;
  literalPreservation?: boolean;
  error?: string;
  elapsedMs: number;
};

function usage() {
  console.log(
    "Synthetic Italian consolidator evaluation. No database access or writes.\n\nUsage: pnpm exec tsx scripts/evaluate-consolidator.ts --live [--case ID] [--output /tmp/report.json] [--max-requests 60] [--timeout-seconds 240] [--stage-fixture] [--technical-retries 0]\n\nWithout --live no provider calls are made. --case may be repeated; default: all six fixtures. One analysis task and at most one proposed operation per case; no repairs or favorable-judgment rerolls. Transport retries default to zero; --technical-retries permits at most two retries of failed HTTP/transport requests only. --output refuses to overwrite an existing file. --stage-fixture requires an explicit editable case and isolates editor/materializer/verifier using an independently defined fixture plan; it is never end-to-end success.\n\nCases: " +
      consolidationFixtures()
        .map((fixture) => fixture.id)
        .join(", "),
  );
}

function safeError(error: unknown): string {
  if (error instanceof GatewayRequestError)
    return `gateway_http_${error.status ?? "transport"}${error.retryable ? "_retryable" : ""}`;
  return error instanceof Error
    ? `${error.name}: ${error.message}`.slice(0, 400)
    : "unknown_error";
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || !args.length) {
    usage();
    return;
  }
  const caseIds: string[] = [];
  let output: string | undefined;
  let maxRequests = 60;
  let timeoutSeconds = 240;
  let live = false;
  let stageFixture = false;
  let technicalRetries = 0;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--live") live = true;
    else if (arg === "--stage-fixture") stageFixture = true;
    else if (arg === "--technical-retries")
      technicalRetries = Number(args[++index]);
    else if (arg === "--case") caseIds.push(args[++index] ?? "");
    else if (arg === "--output") output = args[++index];
    else if (arg === "--max-requests") maxRequests = Number(args[++index]);
    else if (arg === "--timeout-seconds")
      timeoutSeconds = Number(args[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!live)
    throw new Error("Explicit --live is required before any provider call.");
  if (
    !Number.isInteger(technicalRetries) ||
    technicalRetries < 0 ||
    technicalRetries > 2
  )
    throw new Error(
      "--technical-retries must be 0, 1 or 2; only failed transport requests are retried.",
    );
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 100)
    throw new Error("--max-requests must be an integer from 1 to 100.");
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 600
  )
    throw new Error("--timeout-seconds must be an integer from 1 to 600.");
  const allFixtures = consolidationFixtures();
  if (caseIds.some((id) => !allFixtures.some((fixture) => fixture.id === id)))
    throw new Error(
      "Unknown fixture ID. Use --help for the allowed fictional cases.",
    );
  const fixtures = caseIds.length
    ? allFixtures.filter((fixture) => caseIds.includes(fixture.id))
    : allFixtures;
  if (
    stageFixture &&
    (!caseIds.length || fixtures.some((fixture) => !fixture.expected.kind))
  )
    throw new Error(
      "--stage-fixture requires explicit --case IDs with a ground-truth edit.",
    );
  // @next/env's CommonJS build can expose only named exports under tsx.
  (nextEnv?.loadEnvConfig ?? loadEnvConfig)(process.cwd());
  if (!process.env.AI_GATEWAY_API_KEY)
    throw new Error("AI_GATEWAY_API_KEY is not configured.");
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const deadline = AbortSignal.timeout(timeoutSeconds * 1000);
  const fetchOriginal = globalThis.fetch;
  const calls: Call[] = [];
  let currentCase = "";
  let phase = "analysis";
  let exhausted = false;
  // Count both Jev and DeepSeek at the actual HTTP boundary; never log request headers.
  const tracedFetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (
      url.origin !== "https://ai-gateway.vercel.sh" ||
      !["/v1/evaluate", "/v1/chat/completions"].includes(url.pathname)
    )
      throw new Error(
        "Synthetic evaluation attempted an unexpected network destination.",
      );
    if (calls.length >= maxRequests || deadline.aborted) {
      exhausted = true;
      throw new Error(
        "Synthetic evaluation request/deadline budget exhausted.",
      );
    }
    const call: Call = {
      caseId: currentCase,
      phase,
      path: url.pathname,
      elapsedMs: 0,
    };
    calls.push(call);
    const began = Date.now();
    try {
      const response = await fetchOriginal(input, {
        ...init,
        signal: AbortSignal.any([
          deadline,
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
      call.status = response.status;
      if (response.ok) {
        const body = object(await response.clone().json());
        const tokens = object(body?.usage);
        const inputTokens = tokens?.inputTokens ?? tokens?.prompt_tokens;
        const outputTokens = tokens?.outputTokens ?? tokens?.completion_tokens;
        if (typeof inputTokens === "number") call.inputTokens = inputTokens;
        if (typeof outputTokens === "number") call.outputTokens = outputTokens;
        if (typeof body?.model === "string") call.model = body.model;
        const answers = object(body?.answers);
        call.responseShape = {
          keys: Object.keys(body ?? {}),
          answerCount: answers ? Object.keys(answers).length : undefined,
          firstAnswer: answers ? Object.values(answers)[0] : undefined,
        };
      }
      return response;
    } catch (error) {
      call.error = deadline.aborted
        ? "deadline_exceeded"
        : error instanceof Error
          ? error.name
          : "fetch_failed";
      throw error;
    } finally {
      call.elapsedMs = Date.now() - began;
    }
  };
  globalThis.fetch = async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await tracedFetch(input, init);
      } catch (error) {
        if (attempt >= technicalRetries || exhausted || deadline.aborted)
          throw error;
        await delay(500, undefined, { signal: deadline });
        continue;
      }
      const retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      const retryAfter =
        Number(response.headers.get("retry-after") ?? "0") * 1000;
      if (
        !retryable ||
        attempt >= technicalRetries ||
        exhausted ||
        deadline.aborted ||
        retryAfter > 5000
      )
        return response;
      await response.body?.cancel();
      await delay(Math.max(500, retryAfter), undefined, { signal: deadline });
    }
  };
  const cases: CaseResult[] = [];
  try {
    for (const fixture of fixtures) {
      if (exhausted || deadline.aborted || calls.length >= maxRequests) break;
      currentCase = fixture.id;
      phase = "analysis";
      const began = Date.now();
      const result: CaseResult = {
        id: fixture.id,
        description: fixture.description,
        expected: fixture.expected,
        mode: stageFixture ? "fixture_ground_truth_stages" : "end_to_end",
        outcome: "error",
        elapsedMs: 0,
      };
      cases.push(result);
      console.log(
        `[${fixture.id}] ${stageFixture ? "isolating editor/verifier with independent ground-truth plan" : "analyzing fictional fixture"}`,
      );
      try {
        const snapshot = buildSnapshot(
          fixture.pages,
          "2026-09-25T00:00:00.000Z",
        );
        const task = createAnalysisTasks(snapshot).find(
          (candidate) =>
            candidate.pageIds.length === fixture.focusPageIds.length &&
            fixture.focusPageIds.every((id) => candidate.pageIds.includes(id)),
        );
        if (!task) throw new Error("Fixture has no matching focused task.");
        if (stageFixture) {
          result.selectedPlan = fixtureGroundTruthPlan(fixture, snapshot);
          result.plans = [result.selectedPlan];
        } else {
          result.analysis = await analyzeTask(snapshot, task, evaluateJev);
          result.plans = planOperations(snapshot, [result.analysis]);
          result.selectedPlan = fixture.expected.kind
            ? result.plans.find(
                (plan) =>
                  plan.kind === fixture.expected.kind &&
                  (!fixture.expected.linkType ||
                    plan.link?.type === fixture.expected.linkType),
              )
            : result.plans.find((plan) => plan.kind !== "add_link");
        }
        if (result.analysis?.status === "incomplete")
          result.outcome = "incomplete_analysis";
        else if (!result.selectedPlan)
          result.outcome = result.analysis?.findings.some(
            (finding) => finding.status === "uncertain",
          )
            ? "unresolved"
            : "no_change";
        else {
          phase = "editor";
          const draft = await draftChanges(snapshot, result.selectedPlan);
          if (draft.noChange) result.outcome = "editor_no_change";
          else {
            result.changeSet = materializeDraft(
              snapshot,
              result.selectedPlan,
              draft,
            );
            phase = "verifier";
            result.verification = await verifyChangeSet(
              snapshot,
              result.changeSet,
              evaluateJev,
            );
            result.outcome = result.verification.status;
            const finalText = snapshot.pages
              .map(
                (page) =>
                  result.changeSet?.changes.find(
                    (change) => change.after.id === page.id,
                  )?.after.markdown ?? page.markdown,
              )
              .join("\n");
            result.literalPreservation = fixture.expected.preserve?.every(
              (text) => finalText.includes(text),
            );
          }
        }
        result.expectationMet = fixture.expected.kind
          ? result.outcome === "accepted" &&
            result.literalPreservation !== false
          : fixture.expected.unresolved
            ? result.outcome === "unresolved" &&
              !result.plans.some((plan) => plan.kind === "reconcile")
            : result.outcome === "no_change" && !result.plans.length;
      } catch (error) {
        result.error = safeError(error);
      }
      result.elapsedMs = Date.now() - began;
      console.log(
        `[${fixture.id}] ${result.outcome}; expectation=${result.expectationMet ?? "not_evaluated"}; calls=${calls.filter((call) => call.caseId === fixture.id).length}${result.error ? `; ${result.error}` : ""}`,
      );
      // A transport/auth/protocol-wide failure merits inspection, not a cascade of identical calls.
      if (
        result.error ||
        calls.some(
          (call) =>
            call.caseId === fixture.id &&
            (call.status === 401 || call.status === 403),
        )
      )
        break;
    }
  } finally {
    globalThis.fetch = fetchOriginal;
  }
  const report = {
    syntheticOnly: true,
    policyVersion: POLICY.version,
    mode: stageFixture ? "fixture_ground_truth_stages" : "end_to_end",
    writesPerformed: false,
    startedAt,
    elapsedMs: Date.now() - started,
    limits: {
      maxRequests,
      timeoutSeconds,
      oneOperationPerFixture: true,
      technicalRetriesPerRequest: technicalRetries,
      semanticRetries: 0,
      repairs: 0,
    },
    requestedCases: fixtures.map((fixture) => fixture.id),
    skippedCases: fixtures
      .filter((fixture) => !cases.some((result) => result.id === fixture.id))
      .map((fixture) => fixture.id),
    totals: {
      attemptedCases: cases.length,
      semanticCompletedCases: cases.filter(
        (result) =>
          !result.error &&
          result.outcome !== "incomplete_analysis" &&
          !result.verification?.incomplete,
      ).length,
      expectationsMet: cases.filter((result) => result.expectationMet).length,
      technicalErrors: cases.filter(
        (result) =>
          result.error ||
          result.outcome === "incomplete_analysis" ||
          result.verification?.incomplete,
      ).length,
      requests: calls.length,
      inputTokens: calls.reduce(
        (total, call) => total + (call.inputTokens ?? 0),
        0,
      ),
      outputTokens: calls.reduce(
        (total, call) => total + (call.outputTokens ?? 0),
        0,
      ),
      unknownUsageRequests: calls.filter(
        (call) =>
          call.inputTokens === undefined || call.outputTokens === undefined,
      ).length,
    },
    cases,
    calls,
  };
  const serialized = JSON.stringify(report, null, 2);
  if (output) {
    await writeFile(resolve(output), `${serialized}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    console.log(`Report with exact synthetic proposals: ${resolve(output)}`);
  } else
    console.log(
      JSON.stringify(
        {
          mode: report.mode,
          policyVersion: report.policyVersion,
          totals: report.totals,
          cases: cases.map((result) => ({
            id: result.id,
            outcome: result.outcome,
            expectationMet: result.expectationMet,
            error: result.error,
            proposedDiffs: result.changeSet?.draft,
            defects: result.verification?.defects,
          })),
          skippedCases: report.skippedCases,
        },
        null,
        2,
      ),
    );
  console.log(
    `Synthetic evaluation: ${report.totals.attemptedCases}/${fixtures.length} cases attempted; ${report.totals.semanticCompletedCases} semantically completed, ${report.totals.expectationsMet} expectations met, ${report.totals.technicalErrors} technical errors, ${report.skippedCases.length} skipped. ${calls.length} requests; ${report.totals.inputTokens} input / ${report.totals.outputTokens} output tokens.`,
  );
  if (
    report.skippedCases.length ||
    cases.some((result) => !result.expectationMet)
  )
    process.exitCode = 1;
}

main().catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});
