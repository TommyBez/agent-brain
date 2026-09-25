import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import nextEnv, { loadEnvConfig } from "@next/env";
import { analyzeTask } from "../lib/maintenance/consolidator/analysis";
import {
  type DecisionPolicy,
  SEED_DECISION_POLICY,
  validateDecisionPolicy,
} from "../lib/maintenance/consolidator/decision-policy";
import { materializeDraft } from "../lib/maintenance/consolidator/editor";
import { JEV_MODEL } from "../lib/maintenance/consolidator/jev";
import type {
  AnalysisResult,
  Evaluate,
  Verification,
} from "../lib/maintenance/consolidator/types";
import { verifyChangeSet } from "../lib/maintenance/consolidator/verifier";
import { analysisCalibrationCases } from "../tests/helpers/consolidation-analysis-calibration-fixtures";
import { calibrationCases } from "../tests/helpers/consolidation-calibration-cases";
import {
  type AnalysisAssessment,
  analystProfiles,
  assessAnalysis,
  CALIBRATION_PROTOCOL,
  classifyVerification,
  compareAnalystConservatism,
  compareVerifierConservatism,
  diagnoseRawEvaluation,
  digest,
  emptyMetrics,
  errorCode,
  JudgmentCache,
  type Metrics,
  readJson,
  readRawEvaluation,
  replaceJson,
  type Split,
  sanitizeDiagnostic,
  THRESHOLD_GRID,
  type VerifierSignals,
  verifierProfiles,
  verifierSignals,
  writeOnce,
} from "./lib/consolidator-calibration";

type VerifierCase = ReturnType<typeof calibrationCases>[number];
type AnalystCase = ReturnType<typeof analysisCalibrationCases>[number];
type Corpus = { verifier: VerifierCase[]; analyst: AnalystCase[] };
type Manifest = {
  corpusVersion?: 2;
  promptImplementationHash?: string;
  verifierPromptVersion?: "claim-scoped-preservation-2";
  protocol: string;
  corpusHash: string;
  grid: typeof THRESHOLD_GRID;
  analystProfiles: DecisionPolicy[];
  corpus: Corpus;
};
type VerifierResult = {
  id: string;
  status: "complete" | "error" | "structural_rejected";
  requestKeys: string[];
  verification?: Verification;
  signals?: VerifierSignals;
  error?: string;
};
type AnalystResult = {
  id: string;
  profileId: string;
  status: "complete" | "error";
  requestKeys: string[];
  analysis?: AnalysisResult;
  assessment?: AnalysisAssessment;
  error?: string;
};
type Collection = {
  protocol: string;
  corpusHash: string;
  manifestHash: string;
  split: Split;
  profileHash: string | null;
  startedAt: string;
  finishedAt: string;
  live: boolean;
  stats: JudgmentCache["stats"];
  events: JudgmentCache["events"];
  protocolDiagnostics: unknown[];
  providerErrors: {
    status: number;
    code?: string;
    type?: string;
    message?: string;
  }[];
  verifier: VerifierResult[];
  analyst: AnalystResult[];
};
type FrozenProfile = {
  protocol: string;
  corpusHash: string;
  manifestHash: string;
  calibrationReportHash: string;
  policy: DecisionPolicy;
  profileHash: string;
  frozenAt: string;
  baselineSeedMetrics?: { analyst: Metrics; verifier: Metrics };
  selection: {
    analyst: Metrics;
    verifier: Metrics;
    objective: string;
    analystCandidates: number;
    verifierCandidates: number;
  };
};
type Options = {
  command: "manifest" | "collect" | "fit" | "evaluate" | "inspect-raw";
  split: Split;
  directory: string;
  live: boolean;
  profile?: string;
  output?: string;
  maxCalls: number;
  timeoutMs: number;
  concurrency: number;
  retries: number;
  requestKey?: string;
  corpusVersion: 1 | 2;
  reuseDirectories: string[];
};

function usage() {
  console.log(`Synthetic-only consolidation calibration. No database, editor generation or production writes.

node --import tsx scripts/calibrate-consolidator.ts manifest --corpus-version 2 --dir /tmp/consolidator-calibration-v2
node --import tsx scripts/calibrate-consolidator.ts collect --corpus-version 2 --split calibration --dir /tmp/consolidator-calibration-v2 --live
node --import tsx scripts/calibrate-consolidator.ts fit --corpus-version 2 --dir /tmp/consolidator-calibration-v2
node --import tsx scripts/calibrate-consolidator.ts collect --corpus-version 2 --split holdout --dir /tmp/consolidator-calibration-v2 --profile /tmp/consolidator-calibration-v2/profile.json --live
node --import tsx scripts/calibrate-consolidator.ts evaluate --corpus-version 2 --split holdout --dir /tmp/consolidator-calibration-v2 --profile /tmp/consolidator-calibration-v2/profile.json
node --import tsx scripts/calibrate-consolidator.ts inspect-raw --dir /tmp/consolidator-calibration-v2 --request-key SHA256

--live is required for missing provider requests. Without it, collection replays immutable cached judgments only.
Defaults: --max-requests 2000 --timeout-seconds 900 --concurrency 2 --technical-retries 3.
--corpus-version 1 (default) preserves the original experiment; --corpus-version 2 keeps its calibration cases and uses entirely new holdouts. Always select a new --dir for a new version.
--reuse-judgments-from DIRECTORY reuses only exact request keys actually needed by this experiment; may be repeated. Old holdout cases and unrelated cached responses are never imported.
Transport failures are retried; successful semantic answers and malformed provider responses are never rerolled.
Every successful HTTP body is stored privately under raw-http BEFORE JSON/schema parsing and reused on resume. inspect-raw prints sanitized structural diagnostics only.
Manifest and fitted profile are immutable. Resume collect in the same directory to request only missing answers.
Fit refuses errors/incomplete coverage, optimizes calibration only, and freezes the selected policy before holdout.
--output selects an additional immutable JSON output file; --profile selects the frozen profile for evaluation.
`);
}

function parseOptions(): Options | null {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help")) {
    usage();
    return null;
  }
  const command = args.shift();
  if (
    !["manifest", "collect", "fit", "evaluate", "inspect-raw"].includes(
      command ?? "",
    )
  )
    throw new Error("Expected manifest, collect, fit or evaluate.");
  const options: Options = {
    command: command as Options["command"],
    split: "calibration",
    directory: resolve("/tmp/consolidator-calibration"),
    live: false,
    maxCalls: 2000,
    timeoutMs: 900_000,
    concurrency: 2,
    retries: 3,
    corpusVersion: 1,
    reuseDirectories: [],
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--live") options.live = true;
    else if (arg === "--split") {
      const value = args[++index];
      if (value !== "calibration" && value !== "holdout")
        throw new Error("--split must be calibration or holdout.");
      options.split = value;
    } else if (arg === "--dir")
      options.directory = resolve(args[++index] ?? "");
    else if (arg === "--profile")
      options.profile = resolve(args[++index] ?? "");
    else if (arg === "--request-key") options.requestKey = args[++index];
    else if (arg === "--corpus-version") {
      const value = args[++index];
      if (value !== "1" && value !== "2")
        throw new Error("--corpus-version must be 1 or 2.");
      options.corpusVersion = Number(value) as 1 | 2;
    } else if (arg === "--reuse-judgments-from") {
      const value = args[++index];
      if (!value)
        throw new Error("--reuse-judgments-from requires a directory.");
      options.reuseDirectories.push(resolve(value));
    } else if (arg === "--output")
      options.output = resolve(args[++index] ?? "");
    else if (arg === "--max-requests") options.maxCalls = Number(args[++index]);
    else if (arg === "--timeout-seconds")
      options.timeoutMs = Number(args[++index]) * 1000;
    else if (arg === "--concurrency")
      options.concurrency = Number(args[++index]);
    else if (arg === "--technical-retries")
      options.retries = Number(args[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const [name, value, minimum, maximum] of [
    ["max-requests", options.maxCalls, 1, 10000],
    ["timeout-seconds", options.timeoutMs, 1000, 3_600_000],
    ["concurrency", options.concurrency, 1, 6],
    ["technical-retries", options.retries, 0, 3],
  ] as const)
    if (!Number.isInteger(value) || value < minimum || value > maximum)
      throw new Error(`Invalid bounded --${name}.`);
  if (options.command !== "collect" && options.live)
    throw new Error("Only collect may use --live.");
  if (options.command === "fit" && options.split !== "calibration")
    throw new Error("Fit may use calibration outcomes only.");
  return options;
}

async function freezeManifest(options: Options): Promise<Manifest> {
  let corpus: Corpus = {
    verifier: calibrationCases(),
    analyst: analysisCalibrationCases(),
  };
  let versionFields: Pick<
    Manifest,
    "corpusVersion" | "promptImplementationHash" | "verifierPromptVersion"
  > = {};
  if (options.corpusVersion === 2) {
    const [{ calibrationHoldoutV2Cases }, { analysisHoldoutV2Cases }] =
      await Promise.all([
        import("../tests/helpers/consolidation-calibration-holdout-v2"),
        import("../tests/helpers/consolidation-analysis-holdout-v2"),
      ]);
    const newVerifier = calibrationHoldoutV2Cases();
    const newAnalyst = analysisHoldoutV2Cases();
    if (
      [...newVerifier, ...newAnalyst].some(
        (fixture) => fixture.split !== "holdout",
      )
    )
      throw new Error("Version 2 replacement cases must be holdout only.");
    const originalIds = new Set(
      [...corpus.verifier, ...corpus.analyst].map((fixture) => fixture.id),
    );
    if (
      [...newVerifier, ...newAnalyst].some((fixture) =>
        originalIds.has(fixture.id),
      )
    )
      throw new Error(
        "Version 2 holdout identities overlap the observed original corpus.",
      );
    corpus = {
      verifier: [
        ...corpus.verifier.filter((fixture) => fixture.split === "calibration"),
        ...newVerifier,
      ],
      analyst: [
        ...corpus.analyst.filter((fixture) => fixture.split === "calibration"),
        ...newAnalyst,
      ],
    };
    const implementation = await Promise.all(
      ["analysis.ts", "questions.ts", "verifier.ts", "editor.ts"].map(
        async (file) => ({
          file,
          source: await readFile(
            resolve("lib/maintenance/consolidator", file),
            "utf8",
          ),
        }),
      ),
    );
    versionFields = {
      corpusVersion: 2,
      promptImplementationHash: digest(implementation),
      verifierPromptVersion: "claim-scoped-preservation-2",
    };
  }
  const manifest: Manifest = {
    ...versionFields,
    protocol: CALIBRATION_PROTOCOL,
    corpusHash: digest(corpus),
    grid: THRESHOLD_GRID,
    analystProfiles: analystProfiles(),
    corpus,
  };
  const saved = await writeOnce(
    join(options.directory, "manifest.json"),
    manifest,
  );
  if (digest(saved) !== digest(manifest))
    throw new Error(
      "Corpus or candidate grid differs from the frozen manifest. Use a new directory; do not mix experiments.",
    );
  return saved;
}

async function loadFrozenProfile(
  options: Options,
  manifest: Manifest,
): Promise<FrozenProfile> {
  const profile = await readJson<FrozenProfile>(
    options.profile ?? join(options.directory, "profile.json"),
  );
  if (
    !profile ||
    profile.protocol !== CALIBRATION_PROTOCOL ||
    profile.corpusHash !== manifest.corpusHash ||
    profile.manifestHash !== digest(manifest)
  )
    throw new Error("A matching immutable calibration profile is required.");
  validateDecisionPolicy(profile.policy);
  if (
    digest({
      policy: profile.policy,
      corpusHash: profile.corpusHash,
      calibrationReportHash: profile.calibrationReportHash,
    }) !== profile.profileHash
  )
    throw new Error("Frozen profile checksum mismatch.");
  return profile;
}

function trackedEvaluator(cache: JudgmentCache): {
  evaluate: Evaluate;
  keys: Set<string>;
} {
  const keys = new Set<string>();
  return {
    keys,
    evaluate: async (request) => {
      keys.add(digest({ model: JEV_MODEL, ...request }));
      return cache.evaluate(request);
    },
  };
}

async function collect(
  options: Options,
  manifest: Manifest,
): Promise<Collection> {
  if (options.corpusVersion === 1)
    throw new Error(
      "Version 1 is archived: its original raw judgments, profile and reports remain readable, but collection under changed verifier prompts is forbidden. Use --corpus-version 2 with a new directory.",
    );
  const frozen =
    options.split === "holdout"
      ? await loadFrozenProfile(options, manifest)
      : null;
  if (frozen) {
    const lock = {
      profileHash: frozen.profileHash,
      corpusHash: manifest.corpusHash,
      manifestHash: digest(manifest),
    };
    const committed = await writeOnce(
      join(options.directory, "holdout-lock.json"),
      lock,
    );
    if (digest(committed) !== digest(lock))
      throw new Error(
        "Holdout was already opened with another policy. It cannot be reused for model selection.",
      );
  }
  if (options.live) {
    (nextEnv?.loadEnvConfig ?? loadEnvConfig)(process.cwd());
    if (!process.env.AI_GATEWAY_API_KEY)
      throw new Error("AI_GATEWAY_API_KEY is not configured.");
  }
  const cache = new JudgmentCache({
    directory: options.directory,
    live: options.live,
    maxCalls: options.maxCalls,
    timeoutMs: options.timeoutMs,
    concurrency: options.concurrency,
    retries: options.retries,
    reuseDirectories: options.reuseDirectories,
  });
  const report: Collection = {
    protocol: CALIBRATION_PROTOCOL,
    corpusHash: manifest.corpusHash,
    manifestHash: digest(manifest),
    split: options.split,
    profileHash: frozen?.profileHash ?? null,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    live: options.live,
    stats: cache.stats,
    events: cache.events,
    protocolDiagnostics: cache.protocolDiagnostics,
    providerErrors: [],
    verifier: [],
    analyst: [],
  };
  const originalFetch = globalThis.fetch;
  // Bind the existing provider client's own timeout to this collection's deadline.
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (
      !options.live ||
      url.origin !== "https://ai-gateway.vercel.sh" ||
      url.pathname !== "/v1/evaluate"
    )
      throw new Error(
        "Calibration only permits explicit live Jev evaluation requests.",
      );
    const response = await originalFetch(input, {
      ...init,
      signal: AbortSignal.any([
        AbortSignal.timeout(Math.max(1, cache.remainingMs)),
        ...(init?.signal ? [init.signal] : []),
      ]),
    });
    if (!response.ok) {
      const body = (await response
        .clone()
        .json()
        .catch(() => null)) as { error?: unknown } | null;
      const detail = body?.error;
      const error =
        detail && typeof detail === "object"
          ? (detail as Record<string, unknown>)
          : {};
      const clean = (value: unknown): string | undefined =>
        typeof value === "string"
          ? String(sanitizeDiagnostic(value)).slice(0, 300)
          : undefined;
      report.providerErrors.push({
        status: response.status,
        code: clean(error.code),
        type: clean(error.type),
        message: clean(
          error.message ?? (typeof detail === "string" ? detail : undefined),
        ),
      });
    }
    if (typeof init?.body !== "string")
      throw new Error(
        "Expected the exact JSON request body for raw evaluation capture.",
      );
    return await cache.captureRawResponse(init.body, response);
  };
  try {
    for (const fixture of manifest.corpus.verifier.filter(
      (item) => item.split === options.split,
    )) {
      const tracked = trackedEvaluator(cache);
      const result: VerifierResult = {
        id: fixture.id,
        status: "error",
        requestKeys: [],
      };
      try {
        let changeSet: ReturnType<typeof materializeDraft>;
        try {
          changeSet = materializeDraft(
            fixture.snapshot,
            fixture.plan,
            fixture.draft,
          );
        } catch (error) {
          if (fixture.structural === true && !fixture.expectedAccept) {
            result.status = "structural_rejected";
            result.error =
              "Deterministic materialization rejected the structural fixture; excluded from semantic negatives.";
            report.verifier.push(result);
            continue;
          }
          throw error;
        }
        if (fixture.structural)
          throw new Error(
            "A structural rejection fixture unexpectedly materialized.",
          );
        result.verification = await verifyChangeSet(
          fixture.snapshot,
          changeSet,
          tracked.evaluate,
          frozen?.policy ?? SEED_DECISION_POLICY,
        );
        result.signals = verifierSignals(result.verification);
        if (result.signals.deterministicRejected)
          throw new Error(
            "The semantic fixture was rejected before model judgment; this is a structural case, not a model negative.",
          );
        result.status = result.signals.incomplete ? "error" : "complete";
        if (result.signals.incomplete) result.error = "incomplete_verification";
      } catch (error) {
        result.error = errorCode(error);
      }
      result.requestKeys = [...tracked.keys];
      report.verifier.push(result);
      console.log(
        JSON.stringify({
          stage: "verifier",
          case: fixture.id,
          status: result.status,
          calls: cache.stats.calls,
          hits: cache.stats.hits,
        }),
      );
    }
    const profiles = frozen
      ? options.corpusVersion === 2
        ? [frozen.policy, SEED_DECISION_POLICY]
        : [frozen.policy]
      : manifest.analystProfiles;
    for (const fixture of manifest.corpus.analyst.filter(
      (item) => item.split === options.split,
    )) {
      for (const policy of profiles) {
        const tracked = trackedEvaluator(cache);
        const result: AnalystResult = {
          id: fixture.id,
          profileId: policy.id,
          status: "error",
          requestKeys: [],
        };
        try {
          result.analysis = await analyzeTask(
            fixture.snapshot,
            fixture.task,
            tracked.evaluate,
            policy,
          );
          result.assessment = assessAnalysis(result.analysis, fixture.expected);
          result.status =
            result.assessment.outcome === "error" ? "error" : "complete";
          if (result.status === "error") result.error = "incomplete_analysis";
        } catch (error) {
          result.error = errorCode(error);
        }
        result.requestKeys = [...tracked.keys];
        report.analyst.push(result);
      }
      console.log(
        JSON.stringify({
          stage: "analyst",
          case: fixture.id,
          completedProfiles: report.analyst.filter(
            (item) => item.id === fixture.id && item.status === "complete",
          ).length,
          profiles: profiles.length,
          calls: cache.stats.calls,
          hits: cache.stats.hits,
        }),
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  report.finishedAt = new Date().toISOString();
  const output = join(
    options.directory,
    `collection-${options.split}-${report.startedAt.replaceAll(":", "-")}.json`,
  );
  await writeOnce(output, report);
  await replaceJson(join(options.directory, `latest-${options.split}.json`), {
    path: output,
    hash: digest(report),
  });
  console.log(
    JSON.stringify({
      output,
      split: report.split,
      profileHash: report.profileHash,
      stats: cache.stats,
      verifierErrors: report.verifier.filter((item) => item.status === "error")
        .length,
      analystErrors: report.analyst.filter((item) => item.status === "error")
        .length,
    }),
  );
  return report;
}

async function readCollection(
  options: Options,
  manifest: Manifest,
): Promise<Collection> {
  const pointer = await readJson<{ path: string; hash: string }>(
    join(options.directory, `latest-${options.split}.json`),
  );
  if (!pointer) throw new Error("No collection exists for this split.");
  const report = await readJson<Collection>(pointer.path);
  if (
    !report ||
    digest(report) !== pointer.hash ||
    report.protocol !== CALIBRATION_PROTOCOL ||
    report.corpusHash !== manifest.corpusHash ||
    report.manifestHash !== digest(manifest) ||
    report.split !== options.split
  )
    throw new Error(
      "Collection does not match the frozen manifest or its checksum.",
    );
  return report;
}

function analysisMetrics(
  results: AnalystResult[],
  cases: AnalystCase[],
  policyId: string,
): Metrics {
  const metrics = emptyMetrics();
  for (const fixture of cases) {
    metrics.total++;
    const result = results.find(
      (item) => item.id === fixture.id && item.profileId === policyId,
    );
    if (
      !result ||
      result.status === "error" ||
      !result.assessment ||
      !result.analysis
    ) {
      metrics.errors++;
      continue;
    }
    const assessment = assessAnalysis(result.analysis, fixture.expected);
    metrics.eligible++;
    if (assessment.uncertainFindings > 0) metrics.uncertain++;
    if (assessment.outcome === "correct_positive") metrics.trueAccept++;
    else if (assessment.outcome === "correct_negative") metrics.safeNegative++;
    else if (assessment.outcome === "false_accept") metrics.falseAccept++;
    else if (assessment.outcome === "missed_positive") metrics.missedPositive++;
    else metrics.errors++;
  }
  return metrics;
}

function verificationMetrics(
  results: VerifierResult[],
  cases: VerifierCase[],
  policy: DecisionPolicy,
): Metrics {
  const metrics = emptyMetrics();
  for (const fixture of cases) {
    metrics.total++;
    const result = results.find((item) => item.id === fixture.id);
    if (
      result?.status === "structural_rejected" &&
      fixture.structural &&
      !fixture.expectedAccept
    ) {
      metrics.structuralRejected++;
      continue;
    }
    if (!result || result.status !== "complete" || !result.signals) {
      metrics.errors++;
      continue;
    }
    const status = classifyVerification(result.signals, policy);
    if (status === "error") {
      metrics.errors++;
      continue;
    }
    metrics.eligible++;
    if (status === "uncertain") metrics.uncertain++;
    if (status === "accepted") {
      if (fixture.expectedAccept) metrics.trueAccept++;
      else metrics.falseAccept++;
    } else if (fixture.expectedAccept) metrics.missedPositive++;
    else metrics.safeNegative++;
  }
  return metrics;
}

function baselineSeedMetrics(report: Collection, manifest: Manifest) {
  const seedProfileId =
    report.split === "calibration"
      ? manifest.analystProfiles.find(
          (policy) =>
            digest(policy.analyst) === digest(SEED_DECISION_POLICY.analyst),
        )?.id
      : SEED_DECISION_POLICY.id;
  return {
    analyst: analysisMetrics(
      report.analyst,
      manifest.corpus.analyst.filter(
        (fixture) => fixture.split === report.split,
      ),
      seedProfileId ?? "seed_profile_not_collected",
    ),
    verifier: verificationMetrics(
      report.verifier,
      manifest.corpus.verifier.filter(
        (fixture) => fixture.split === report.split,
      ),
      SEED_DECISION_POLICY,
    ),
  };
}

async function fit(
  options: Options,
  manifest: Manifest,
): Promise<FrozenProfile> {
  if (await readJson(join(options.directory, "holdout-lock.json")))
    throw new Error(
      "Holdout has already been opened. Fitting again would contaminate its independence.",
    );
  const report = await readCollection(options, manifest);
  if (report.profileHash !== null)
    throw new Error(
      "Calibration collection unexpectedly used a fitted profile.",
    );
  const analysisCases = manifest.corpus.analyst.filter(
    (fixture) => fixture.split === "calibration",
  );
  const verifierCases = manifest.corpus.verifier.filter(
    (fixture) => fixture.split === "calibration",
  );
  let bestAnalyst: { policy: DecisionPolicy; metrics: Metrics } | undefined;
  for (const policy of manifest.analystProfiles) {
    const metrics = analysisMetrics(report.analyst, analysisCases, policy.id);
    if (metrics.errors)
      throw new Error(
        `Incomplete calibration analysis for ${policy.id}: ${metrics.errors} cases. Resume collection before fitting.`,
      );
    if (metrics.falseAccept) continue;
    if (
      !bestAnalyst ||
      metrics.trueAccept > bestAnalyst.metrics.trueAccept ||
      (metrics.trueAccept === bestAnalyst.metrics.trueAccept &&
        compareAnalystConservatism(policy, bestAnalyst.policy) > 0)
    )
      bestAnalyst = { policy, metrics };
  }
  let bestVerifier: { policy: DecisionPolicy; metrics: Metrics } | undefined;
  let verifierCandidates = 0;
  for (const policy of verifierProfiles()) {
    verifierCandidates++;
    const metrics = verificationMetrics(report.verifier, verifierCases, policy);
    if (metrics.errors)
      throw new Error(
        `Incomplete calibration verifier: ${metrics.errors} cases. Resume collection before fitting.`,
      );
    if (metrics.falseAccept) continue;
    if (
      !bestVerifier ||
      metrics.trueAccept > bestVerifier.metrics.trueAccept ||
      (metrics.trueAccept === bestVerifier.metrics.trueAccept &&
        compareVerifierConservatism(policy, bestVerifier.policy) > 0)
    )
      bestVerifier = { policy, metrics };
  }
  if (!bestAnalyst || !bestVerifier)
    throw new Error(
      "No candidate policy achieved zero false accepts on the calibration corpus. Preserve the seed and inspect the failure; never tune on holdout.",
    );
  const policy: DecisionPolicy = {
    id: "pending",
    analyst: bestAnalyst.policy.analyst,
    verifier: bestVerifier.policy.verifier,
  };
  policy.id = `consolidator-calibrated-${digest({
    analyst: policy.analyst,
    verifier: policy.verifier,
    corpusHash: manifest.corpusHash,
    // Changed questions must invalidate derived runtime decisions even when
    // their fitted numeric thresholds happen to remain identical.
    ...(manifest.corpusVersion === 2 ? { manifestHash: digest(manifest) } : {}),
  }).slice(0, 16)}`;
  const profile: FrozenProfile = {
    protocol: CALIBRATION_PROTOCOL,
    corpusHash: manifest.corpusHash,
    manifestHash: digest(manifest),
    calibrationReportHash: digest(report),
    policy,
    profileHash: digest({
      policy,
      corpusHash: manifest.corpusHash,
      calibrationReportHash: digest(report),
    }),
    frozenAt: new Date().toISOString(),
    baselineSeedMetrics: baselineSeedMetrics(report, manifest),
    selection: {
      analyst: bestAnalyst.metrics,
      verifier: bestVerifier.metrics,
      analystCandidates: manifest.analystProfiles.length,
      verifierCandidates,
      objective:
        "Fit calibration only. Independently maximize completely correct positive analyst cases and accepted valid edits, subject to zero false accepts. Analyst tie: no confidence gate, then higher probability threshold. Verifier tie: higher integrity, conduct, link, objective thresholds. Reject boundary fixed to seed, not calibrated.",
    },
  };
  const path = options.profile ?? join(options.directory, "profile.json");
  const committed = await writeOnce(path, profile);
  if (committed.profileHash !== profile.profileHash)
    throw new Error(
      "A different frozen profile already exists. It cannot be overwritten.",
    );
  console.log(JSON.stringify({ output: path, ...committed }));
  return committed;
}

async function evaluate(options: Options, manifest: Manifest) {
  const frozen = await loadFrozenProfile(options, manifest);
  const report = await readCollection(options, manifest);
  if (options.split === "holdout" && report.profileHash !== frozen.profileHash)
    throw new Error(
      "Holdout collection was not sealed under this profile before observing responses.",
    );
  const analysisCases = manifest.corpus.analyst.filter(
    (fixture) => fixture.split === options.split,
  );
  const verifierCases = manifest.corpus.verifier.filter(
    (fixture) => fixture.split === options.split,
  );
  const profileId =
    options.split === "holdout"
      ? frozen.policy.id
      : manifest.analystProfiles.find(
          (policy) => digest(policy.analyst) === digest(frozen.policy.analyst),
        )?.id;
  if (!profileId)
    throw new Error(
      "Fitted analyst policy is absent from the preregistered grid.",
    );
  const metrics = {
    analyst: analysisMetrics(report.analyst, analysisCases, profileId),
    verifier: verificationMetrics(
      report.verifier,
      verifierCases,
      frozen.policy,
    ),
  };
  const details = {
    analyst: analysisCases.map((fixture) => {
      const result = report.analyst.find(
        (item) => item.id === fixture.id && item.profileId === profileId,
      );
      return {
        id: fixture.id,
        expected: fixture.expected,
        status: result?.status ?? "missing",
        assessment: result?.analysis
          ? assessAnalysis(result.analysis, fixture.expected)
          : null,
        error: result?.error,
      };
    }),
    verifier: verifierCases.map((fixture) => {
      const result = report.verifier.find((item) => item.id === fixture.id);
      return {
        id: fixture.id,
        scenarioId: fixture.scenarioId,
        category: fixture.category,
        expectedAccept: fixture.expectedAccept,
        expectedViolation: fixture.expectedViolation ?? null,
        status: result?.signals
          ? classifyVerification(result.signals, frozen.policy)
          : (result?.status ?? "missing"),
        minima: result?.signals?.minima,
        error: result?.error,
      };
    }),
  };
  const summary = {
    protocol: CALIBRATION_PROTOCOL,
    split: options.split,
    corpusHash: manifest.corpusHash,
    profileHash: frozen.profileHash,
    collectionHash: digest(report),
    policy: frozen.policy,
    metrics,
    baselineSeedMetrics: baselineSeedMetrics(report, manifest),
    complete: metrics.analyst.errors === 0 && metrics.verifier.errors === 0,
    zeroFalseAccepts:
      metrics.analyst.falseAccept === 0 && metrics.verifier.falseAccept === 0,
    useful: metrics.analyst.trueAccept > 0 && metrics.verifier.trueAccept > 0,
    details,
  };
  const path = join(
    options.directory,
    `evaluation-${options.split}-${frozen.profileHash.slice(0, 16)}-${digest(report).slice(0, 12)}-with-baseline.json`,
  );
  await writeOnce(path, summary);
  console.log(JSON.stringify({ output: path, ...summary }));
  return summary;
}

async function main() {
  const options = parseOptions();
  if (!options) return;
  if (options.command === "inspect-raw") {
    if (!options.requestKey) throw new Error("--request-key is required.");
    const raw = await readRawEvaluation(options.directory, options.requestKey);
    if (!raw)
      throw new Error(
        "No raw HTTP response was captured for this key. Earlier protocol failures predate raw capture and cannot be reconstructed.",
      );
    console.log(JSON.stringify(diagnoseRawEvaluation(raw), null, 2));
    return;
  }
  const manifest = await freezeManifest(options);
  let result: unknown;
  if (options.command === "manifest") {
    result = {
      output: join(options.directory, "manifest.json"),
      corpusHash: manifest.corpusHash,
      manifestHash: digest(manifest),
      verifierCases: manifest.corpus.verifier.length,
      analystCases: manifest.corpus.analyst.length,
      analystProfiles: manifest.analystProfiles.length,
      model: JEV_MODEL,
    };
    console.log(JSON.stringify(result));
  } else if (options.command === "collect")
    result = await collect(options, manifest);
  else if (options.command === "fit") result = await fit(options, manifest);
  else result = await evaluate(options, manifest);
  if (options.output) {
    const saved = await writeOnce(options.output, result);
    if (digest(saved) !== digest(result))
      throw new Error(
        "--output exists with different contents and was not overwritten.",
      );
  }
}

main().catch((error: unknown) => {
  console.error(errorCode(error));
  process.exitCode = 1;
});
