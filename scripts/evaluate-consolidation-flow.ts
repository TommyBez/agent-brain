import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import nextEnv, { loadEnvConfig } from "@next/env";
import type { BrainLink, BrainPage } from "../lib/brain/types";
import { analyzeTask } from "../lib/maintenance/consolidator/analysis";
import { canReuseDecision } from "../lib/maintenance/consolidator/cache";
import {
  CapacityError,
  capacityVerification,
} from "../lib/maintenance/consolidator/capacity";
import {
  type DecisionPolicy,
  validateDecisionPolicy,
} from "../lib/maintenance/consolidator/decision-policy";
import {
  draftChanges,
  materializeDraft,
} from "../lib/maintenance/consolidator/editor";
import {
  planOperations,
  selectIndependentPlans,
} from "../lib/maintenance/consolidator/planner";
import {
  type RunnerSteps,
  runConsolidation,
} from "../lib/maintenance/consolidator/runner";
import {
  buildSnapshot,
  createAnalysisTasks,
} from "../lib/maintenance/consolidator/snapshot";
import type {
  AnalysisResult,
  ChangeSet,
  DecisionRecord,
  Draft,
  OperationPlan,
  Snapshot,
} from "../lib/maintenance/consolidator/types";
import { verifyChangeSet } from "../lib/maintenance/consolidator/verifier";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import {
  digest,
  errorCode,
  JudgmentCache,
  readJson,
  writeOnce,
} from "./lib/consolidator-calibration";

const SCENARIO_VERSION = "consolidation-flow-2026-09-25-1";
const EMPLOYMENT =
  "Silvia Rosi, persona fittizia SR-61, lavora a tempo parziale per Cartaria CR-4, impresa fittizia con sede a Pavia, dal 6 aprile 2026. Il contratto copre 24 ore settimanali ed esclude il lavoro festivo. Fonte: comunicato originale CR-4/P-8 del 2 aprile 2026.";

function page(
  id: string,
  title: string,
  markdown: string,
  type: BrainPage["type"],
): BrainPage {
  return {
    id,
    slug: id,
    title,
    type,
    markdown,
    summary: "",
    aliases: [],
    tags: [],
    version: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    embeddedAt: null,
    links: [],
    backlinks: [],
  };
}

/** Frozen before threshold selection; no private corpus or database is read. */
function scenario(): BrainPage[] {
  return [
    page(
      "flow-person-sr61",
      "Silvia Rosi, persona fittizia SR-61",
      `${EMPLOYMENT}\n\n${EMPLOYMENT}`,
      "person",
    ),
    page(
      "flow-employer-cr4",
      "Cartaria, impresa fittizia CR-4",
      "Cartaria CR-4 è un'impresa fittizia con sede a Pavia che restaura documenti cartacei. Fonte: anagrafica CR-4.",
      "client",
    ),
    page(
      "flow-namesake-cr19",
      "Cartaria, impresa fittizia CR-19",
      "Cartaria CR-19 è un'impresa fittizia con sede a Parma che produce arredi metallici. Fonte: anagrafica CR-19.",
      "client",
    ),
  ];
}

const allowedLinks = new Set([
  "flow-person-sr61|works_at|flow-employer-cr4",
  "flow-person-sr61|references|flow-employer-cr4",
  "flow-person-sr61|relates_to|flow-employer-cr4",
  "flow-employer-cr4|relates_to|flow-person-sr61",
]);

type Call = {
  run: number;
  wave: number;
  phase: string;
  path: string;
  elapsedMs: number;
  status?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
};

function usage() {
  console.log(
    "Synthetic multistep consolidator evaluation: real analyst, planner, editor and verifier; writes are in_memory only. No production database access.\n\nUsage: pnpm exec tsx scripts/evaluate-consolidation-flow.ts --profile /tmp/frozen-policy.json [--live] [--output /tmp/flow.json] [--cache /tmp/flow-cache] [--max-requests 300] [--max-waves 8] [--timeout-seconds 1200]\n\nWithout --live, prints the frozen scenario and makes no model calls. JSON profile accepts DecisionPolicy or {policy: DecisionPolicy}. At most three technical retries, no successful-judgment rerolls. The wave budget reserves one full pass for the second-run stability check. --output refuses overwrite.",
  );
}

function scoped(snapshot: Snapshot, plan: OperationPlan): Snapshot {
  const ids = new Set(plan.readSet.map((ref) => ref.pageId));
  return {
    ...snapshot,
    pages: snapshot.pages.filter((page) => ids.has(page.id)),
    units: snapshot.units.filter((unit) => ids.has(unit.pageId)),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || !args.length) return usage();
  let profilePath: string | undefined;
  let live = false;
  let maxRequests = 300;
  let maxWaves = 8;
  let timeoutSeconds = 1200;
  let output = `/tmp/consolidation-flow-${Date.now()}.json`;
  let cacheDirectory = "/tmp/consolidation-flow-cache";
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--live") live = true;
    else if (argument === "--profile") profilePath = args[++index];
    else if (argument === "--output") output = args[++index];
    else if (argument === "--cache") cacheDirectory = args[++index];
    else if (argument === "--max-requests") maxRequests = Number(args[++index]);
    else if (argument === "--max-waves") maxWaves = Number(args[++index]);
    else if (argument === "--timeout-seconds")
      timeoutSeconds = Number(args[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!profilePath)
    throw new Error("An explicit frozen --profile JSON is required.");
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 300)
    throw new Error("--max-requests must be an integer from 1 to 300.");
  if (!Number.isInteger(maxWaves) || maxWaves < 2 || maxWaves > 8)
    throw new Error(
      "--max-waves must be an integer from 2 to 8, including the stability pass.",
    );
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 3600
  )
    throw new Error("--timeout-seconds must be an integer from 1 to 3600.");
  const raw = JSON.parse(await readFile(resolve(profilePath), "utf8"));
  const policy = validateDecisionPolicy((raw.policy ?? raw) as DecisionPolicy);
  const before = scenario();
  const manifest = {
    scenarioVersion: SCENARIO_VERSION,
    before,
    expected: {
      personMarkdown: EMPLOYMENT,
      requiredLink: "flow-person-sr61|works_at|flow-employer-cr4",
      allowedLinks: [...allowedLinks],
      otherMarkdownUnchanged: true,
      secondRunWrites: 0,
      secondRunStoppedBy: "stable",
    },
  };
  if (!live) {
    console.log(
      JSON.stringify(
        {
          mode: "offline_manifest",
          policy,
          scenarioHash: digest(manifest),
          manifest,
        },
        null,
        2,
      ),
    );
    return;
  }
  output = resolve(output);
  cacheDirectory = resolve(cacheDirectory);
  try {
    await access(output);
    throw new Error("Output already exists; choose a new report path.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  (nextEnv?.loadEnvConfig ?? loadEnvConfig)(process.cwd());
  if (!process.env.AI_GATEWAY_API_KEY)
    throw new Error("AI_GATEWAY_API_KEY is not configured.");
  const frozen = await writeOnce(
    join(cacheDirectory, "scenario.json"),
    manifest,
  );
  if (digest(frozen) !== digest(manifest))
    throw new Error("Cache belongs to a different frozen scenario.");

  const started = Date.now();
  const deadline = AbortSignal.timeout(timeoutSeconds * 1000);
  const originalFetch = globalThis.fetch;
  const calls: Call[] = [];
  let currentRun = 1;
  let wave = 0;
  let phase = "analysis";
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (
      url.origin !== "https://ai-gateway.vercel.sh" ||
      !["/v1/evaluate", "/v1/chat/completions"].includes(url.pathname)
    )
      throw new Error(
        "Unexpected network destination in synthetic flow evaluation.",
      );
    if (calls.length >= maxRequests || deadline.aborted)
      throw new Error("Combined model request or deadline budget exhausted.");
    const call: Call = {
      run: currentRun,
      wave,
      phase,
      path: url.pathname,
      elapsedMs: 0,
    };
    calls.push(call);
    const began = Date.now();
    try {
      let response = await originalFetch(input, {
        ...init,
        signal: AbortSignal.any([
          deadline,
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
      call.status = response.status;
      if (url.pathname === "/v1/evaluate" && response.ok) {
        if (typeof init?.body !== "string")
          throw new Error("Expected an exact evaluation request body.");
        response = await cache.captureRawResponse(init.body, response);
      }
      if (response.ok) {
        const body = await response.clone().json();
        call.model = body.model;
        call.inputTokens = body.usage?.inputTokens ?? body.usage?.prompt_tokens;
        call.outputTokens =
          body.usage?.outputTokens ?? body.usage?.completion_tokens;
      }
      return response;
    } catch (error) {
      call.error = error instanceof Error ? error.name : "fetch_failed";
      throw error;
    } finally {
      call.elapsedMs = Date.now() - began;
    }
  };
  const cache = new JudgmentCache({
    directory: cacheDirectory,
    live: true,
    maxCalls: maxRequests,
    timeoutMs: timeoutSeconds * 1000,
    concurrency: 3,
    retries: 3,
  });
  const records: { run: number; wave: number; key: string; value: unknown }[] =
    [];
  const snapshots: { run: number; wave: number; snapshot: Snapshot }[] = [];
  const analyses: { run: number; wave: number; result: AnalysisResult }[] = [];
  const decisions = new Map<string, DecisionRecord>();
  const receipts = new Map<string, BrainPage[]>();
  const pages = new Map(before.map((page) => [page.id, structuredClone(page)]));
  let editorCacheHits = 0;
  let editorAttempts = 0;
  let verifierRuns = 0;

  async function editor(
    snapshot: Snapshot,
    plan: OperationPlan,
    feedback: string[] = [],
  ): Promise<Draft> {
    const key = digest({
      snapshot: scoped(snapshot, plan),
      plan,
      feedback,
      editor: process.env.CONSOLIDATION_MODEL || "deepseek/deepseek-v4.1-flash",
      protocol: SCENARIO_VERSION,
    });
    const path = join(cacheDirectory, "drafts", `${key}.json`);
    const cached = await readJson<{ key: string; draft: Draft }>(path);
    if (cached) {
      if (cached.key !== key)
        throw new Error("Cached draft identity mismatch.");
      editorCacheHits++;
      return cached.draft;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        editorAttempts++;
        const draft = await draftChanges(
          scoped(snapshot, plan),
          plan,
          feedback,
        );
        return (await writeOnce(path, { key, draft })).draft;
      } catch (error) {
        if (
          !(error instanceof GatewayRequestError) ||
          !error.retryable ||
          attempt >= 3 ||
          deadline.aborted ||
          calls.length >= maxRequests
        )
          throw error;
        await delay(
          Math.min(
            30_000,
            Math.max(500 * 2 ** attempt, error.retryAfterMs ?? 0),
          ),
          undefined,
          { signal: deadline },
        );
      }
    }
  }

  const steps: RunnerSteps = {
    async snapshot() {
      wave++;
      const snapshot = buildSnapshot(
        [...pages.values()],
        "2026-09-25T00:00:00.000Z",
      );
      snapshots.push({ run: currentRun, wave, snapshot });
      return snapshot;
    },
    async scan(snapshot, remainingBudget) {
      const tasks = createAnalysisTasks(snapshot);
      // Both runs cover every current task; raw exact-request judgments may be reused.
      return {
        tasks: tasks.slice(0, remainingBudget),
        cached: [],
        total: tasks.length,
        remaining: Math.max(0, tasks.length - remainingBudget),
      };
    },
    async analyze(snapshot, task) {
      phase = "analysis";
      const result = await analyzeTask(snapshot, task, cache.evaluate, policy);
      analyses.push({ run: currentRun, wave, result });
      return result;
    },
    async plan(snapshot, results) {
      let capacityLimited = 0;
      const candidates = planOperations(snapshot, results).filter((plan) => {
        const prior =
          decisions.get(`${plan.id}:${snapshot.id}`) ?? decisions.get(plan.id);
        if (!canReuseDecision(snapshot, prior)) return true;
        if (prior?.reason === "capacity") capacityLimited++;
        return false;
      });
      const selection = selectIndependentPlans(candidates);
      return {
        selected: selection.selected,
        deferred: selection.deferred.length,
        capacityLimited,
      };
    },
    async draft(snapshot, plan, _attempt, feedback) {
      phase = "editor";
      return editor(snapshot, plan, feedback);
    },
    async review(snapshot, plan, draft) {
      phase = "verifier";
      let changeSet: ChangeSet;
      try {
        changeSet = materializeDraft(scoped(snapshot, plan), plan, draft);
      } catch (error) {
        if (error instanceof CapacityError)
          return {
            changeSet: null,
            verification: capacityVerification(error.capacity),
          };
        return {
          changeSet: null,
          verification: {
            status: "rejected",
            defects: [errorCode(error)],
            judgments: [],
          },
        };
      }
      verifierRuns++;
      return {
        changeSet,
        verification: await verifyChangeSet(
          scoped(snapshot, plan),
          changeSet,
          cache.evaluate,
          policy,
        ),
      };
    },
    async expand(snapshot, plan, depth) {
      // The scenario fits one full context; linked and global pools are the same at most once.
      if (depth > 1 || plan.readSet.length === snapshot.pages.length)
        return null;
      return {
        ...plan,
        evidenceUnitIds: snapshot.units.map((unit) => unit.id),
        readSet: snapshot.pages.map((page) => ({
          pageId: page.id,
          version: page.version,
        })),
      };
    },
    async apply(changeSet) {
      phase = "in_memory_apply";
      const receipt = receipts.get(changeSet.id);
      if (receipt)
        return { status: "replayed", pages: structuredClone(receipt) };
      const conflicts = changeSet.plan.readSet
        .filter((ref) => pages.get(ref.pageId)?.version !== ref.version)
        .map((ref) => ref.pageId);
      if (conflicts.length) return { status: "conflict", pageIds: conflicts };
      // Check every before-image before committing this entire synthetic change set.
      for (const change of changeSet.changes) {
        if (digest(pages.get(change.before.id)) !== digest(change.before))
          return { status: "conflict", pageIds: [change.before.id] };
      }
      const updated = changeSet.changes.map((change) => ({
        ...structuredClone(change.after),
        version: change.before.version + 1,
        updatedAt: new Date(
          Date.UTC(2026, 8, 25, 0, 0, receipts.size + 1),
        ).toISOString(),
        embeddedAt: null,
      }));
      for (const page of updated) pages.set(page.id, page);
      const allLinks = [...pages.values()].flatMap((page) => page.links);
      for (const page of pages.values())
        page.backlinks = structuredClone(
          allLinks.filter((link) => link.targetId === page.id),
        );
      const committed = updated.map((page) =>
        structuredClone(pages.get(page.id) as BrainPage),
      );
      receipts.set(changeSet.id, committed);
      return { status: "applied", pages: structuredClone(committed) };
    },
    async record(key, value) {
      records.push({ run: currentRun, wave, key, value });
      if (key.startsWith("decision:"))
        decisions.set(key.slice("decision:".length), value as DecisionRecord);
    },
  };
  try {
    const options = {
      maxWaves: maxWaves - 1,
      taskBudget: 2000,
      concurrency: 2,
      repairs: 1,
      expansions: 2,
    };
    const firstRun = await runConsolidation(steps, options);
    const afterFirst = structuredClone([...pages.values()]);
    currentRun = 2;
    wave = 0;
    const secondRun = await runConsolidation(steps, {
      ...options,
      maxWaves: 1,
    });
    const after = structuredClone([...pages.values()]);
    const person = after.find((page) => page.id === "flow-person-sr61");
    const finalLinks = after.flatMap((page) => page.links);
    const key = (edge: BrainLink) =>
      `${edge.sourceId}|${edge.type}|${edge.targetId}`;
    const checks = {
      exactUniqueFactPreserved: person?.markdown.trim() === EMPLOYMENT,
      duplicateRemoved:
        (person?.markdown.split(EMPLOYMENT).length ?? 1) - 1 === 1,
      correctEmploymentLink: finalLinks.some(
        (edge) => key(edge) === manifest.expected.requiredLink,
      ),
      noUnexpectedRelations: finalLinks.every((edge) =>
        allowedLinks.has(key(edge)),
      ),
      otherKnowledgeUnchanged: before
        .filter((page) => page.id !== "flow-person-sr61")
        .every(
          (page) =>
            after.find((result) => result.id === page.id)?.markdown ===
            page.markdown,
        ),
      noNewProseOrSummary: after.every(
        (page) =>
          page.summary === "" &&
          page.markdown.trim() ===
            (page.id === "flow-person-sr61"
              ? EMPLOYMENT
              : before.find((original) => original.id === page.id)?.markdown),
      ),
      completeFirstRun:
        firstRun.status === "succeeded" && firstRun.stoppedBy === "stable",
      secondFullRunStable:
        secondRun.status === "succeeded" &&
        secondRun.stoppedBy === "stable" &&
        secondRun.writes === 0 &&
        secondRun.evaluatedTasks ===
          createAnalysisTasks(buildSnapshot(after)).length &&
        digest(afterFirst) === digest(after),
    };
    const phaseMetrics = ["analysis", "editor", "verifier"].map((name) => {
      const selected = calls.filter((call) => call.phase === name);
      return {
        phase: name,
        networkRequests: selected.length,
        successfulRequests: selected.filter((call) => call.status === 200)
          .length,
        failures: selected.filter((call) => call.status !== 200).length,
        requestElapsedMs: selected.reduce(
          (sum, call) => sum + call.elapsedMs,
          0,
        ),
        inputTokens: selected.reduce(
          (sum, call) => sum + (call.inputTokens ?? 0),
          0,
        ),
        outputTokens: selected.reduce(
          (sum, call) => sum + (call.outputTokens ?? 0),
          0,
        ),
      };
    });
    const report = {
      mode: "in_memory",
      scenarioVersion: SCENARIO_VERSION,
      scenarioHash: digest(manifest),
      policy,
      manifest,
      firstRun,
      secondRun,
      checks,
      passed: Object.values(checks).every(Boolean),
      elapsedMs: Date.now() - started,
      metrics: {
        requests: calls.length,
        phaseMetrics,
        judgmentCache: cache.stats,
        editorCacheHits,
        editorAttempts,
        verifierRuns,
        appliedChangeSets: receipts.size,
      },
      before,
      afterFirst,
      after,
      actualChanges: before.map((original) => ({
        pageId: original.id,
        before: original.markdown,
        after: after.find((page) => page.id === original.id)?.markdown,
        links: after.find((page) => page.id === original.id)?.links,
      })),
      calls,
      snapshots,
      analyses,
      records,
    };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      JSON.stringify(
        {
          mode: report.mode,
          passed: report.passed,
          checks,
          firstRun,
          secondRun,
          metrics: report.metrics,
          actualChanges: report.actualChanges,
          output,
        },
        null,
        2,
      ),
    );
    if (!report.passed) process.exitCode = 1;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(errorCode(error));
  process.exitCode = 1;
});
