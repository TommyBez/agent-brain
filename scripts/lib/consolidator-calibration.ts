import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type DecisionPolicy,
  SEED_DECISION_POLICY,
  type VerificationFamily,
  verificationFamily,
} from "../../lib/maintenance/consolidator/decision-policy";
import {
  evaluateJev,
  JEV_MODEL,
  parseEvaluation,
  validateEvaluation,
} from "../../lib/maintenance/consolidator/jev";
import type {
  AnalysisResult,
  Evaluate,
  Evaluation,
  EvaluationRequest,
  Finding,
  OperationKind,
  Verification,
} from "../../lib/maintenance/consolidator/types";
import { GatewayRequestError } from "../../lib/maintenance/gateway";

export const THRESHOLD_GRID = [
  0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.98,
] as const;
export const CALIBRATION_PROTOCOL = "consolidator-calibration-1";
export type Split = "calibration" | "holdout";

/** Diagnostics may be copied into reports; provider credentials and quota IDs may not. */
export function sanitizeDiagnostic(value: unknown): unknown {
  if (typeof value === "string")
    return value
      .replaceAll(
        process.env.AI_GATEWAY_API_KEY || "__no_gateway_key__",
        "[redacted]",
      )
      .replace(/api_key_id_[A-Za-z0-9_-]+/gi, "api_key_id_[redacted]")
      .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]");
  if (Array.isArray(value)) return value.map(sanitizeDiagnostic);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:api[_-]?key(?:[_-]?id)?|authorization|access[_-]?token|secret)$/i.test(
          key,
        )
          ? "[redacted]"
          : sanitizeDiagnostic(item),
      ]),
    );
  return value;
}

function sanitizedEvaluation(
  request: EvaluationRequest,
  evaluation: Evaluation,
): Evaluation {
  const valid = validateEvaluation(request, evaluation);
  return {
    ...valid,
    ...(valid.providerMetadata === undefined
      ? {}
      : {
          providerMetadata: sanitizeDiagnostic(
            valid.providerMetadata,
          ) as Evaluation["providerMetadata"],
        }),
  };
}

export type RawHttpEvaluation = {
  version: 1;
  key: string;
  requestBody: string;
  status: number;
  responseBody: string;
  recordedAt: string;
};

/** Local raw files are private diagnostics and must not be copied to repository reports. */
export async function readRawEvaluation(
  directory: string,
  key: string,
): Promise<RawHttpEvaluation | null> {
  if (!/^[a-f0-9]{64}$/.test(key))
    throw new Error("Invalid raw evaluation request key.");
  const raw = await readJson<RawHttpEvaluation>(
    join(directory, "raw-http", `${key}.json`),
  );
  if (
    raw &&
    (raw.version !== 1 ||
      raw.key !== key ||
      createHash("sha256").update(raw.requestBody).digest("hex") !== key ||
      raw.status < 200 ||
      raw.status >= 300 ||
      typeof raw.responseBody !== "string")
  )
    throw new Error("Raw evaluation identity failed validation.");
  return raw;
}

/** Field names, types and probability invariants only; never return raw metadata or errors. */
export function diagnoseRawEvaluation(raw: RawHttpEvaluation) {
  const body = JSON.parse(raw.requestBody) as EvaluationRequest & {
    model: string;
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.responseBody);
  } catch {
    return {
      key: raw.key,
      status: raw.status,
      valid: false,
      problems: ["invalid_json"],
    };
  }
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const envelope = object(parsed);
  const answers = object(envelope?.answers);
  const problems: string[] = [];
  try {
    parseEvaluation(body, parsed);
  } catch {
    problems.push("parseEvaluation_rejected");
  }
  const entries = Object.entries(body.questions).map(([id, question]) => {
    const answer = object(answers?.[id]);
    const issues: string[] = [];
    if (!answer) issues.push("missing_or_non_object_answer");
    if (answer?.type !== question.type) issues.push("answer_type_mismatch");
    if (
      question.type === "boolean" &&
      (typeof answer?.probability !== "number" ||
        !Number.isFinite(answer.probability) ||
        answer.probability < 0 ||
        answer.probability > 1)
    )
      issues.push("invalid_probability");
    let sum: number | undefined;
    if (question.type === "choice") {
      const probabilities = object(answer?.probabilities);
      if (
        !probabilities ||
        digest(Object.keys(probabilities).sort()) !==
          digest(Object.keys(question.criteria).sort())
      )
        issues.push("choice_option_keys_mismatch");
      const values = Object.values(probabilities ?? {});
      if (
        values.some(
          (value) =>
            typeof value !== "number" ||
            !Number.isFinite(value) ||
            value < 0 ||
            value > 1,
        )
      )
        issues.push("invalid_choice_probability");
      else {
        sum = (values as number[]).reduce((total, value) => total + value, 0);
        if (Math.abs(sum - 1) > 0.001)
          issues.push("distribution_sum_outside_tolerance");
      }
      if (
        typeof answer?.choice !== "string" ||
        !Object.hasOwn(question.criteria, answer.choice)
      )
        issues.push("invalid_selected_choice");
      else if (
        values.some(
          (value) =>
            typeof value === "number" &&
            value > Number(probabilities?.[answer.choice as string]) + 0.000001,
        )
      )
        issues.push("selected_choice_not_argmax");
    }
    const permitted =
      question.type === "boolean"
        ? ["type", "probability"]
        : ["type", "choice", "probabilities", "confidence"];
    if (Object.keys(answer ?? {}).some((key) => !permitted.includes(key)))
      issues.push("unknown_answer_fields");
    return {
      id,
      type: question.type,
      fields: Object.keys(answer ?? {}),
      issues,
      ...(sum === undefined ? {} : { probabilitySum: sum }),
    };
  });
  const shape = (value: unknown, depth = 0): unknown =>
    depth > 4
      ? typeof value
      : Array.isArray(value)
        ? "array"
        : value === null
          ? "null"
          : typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value as Record<string, unknown>).map(
                  ([key, item]) => [key, shape(item, depth + 1)],
                ),
              )
            : typeof value;
  return sanitizeDiagnostic({
    key: raw.key,
    status: raw.status,
    valid: problems.length === 0,
    problems,
    responseFields: Object.keys(envelope ?? {}),
    unexpectedAnswers: Object.keys(answers ?? {}).filter(
      (id) => !Object.hasOwn(body.questions, id),
    ),
    envelopeShape: shape({
      model: envelope?.model,
      usage: envelope?.usage,
      providerMetadata: envelope?.providerMetadata,
    }),
    answers: entries,
  });
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function analystProfiles(): DecisionPolicy[] {
  return THRESHOLD_GRID.flatMap((threshold) =>
    [null, threshold].map((confidence) => ({
      ...structuredClone(SEED_DECISION_POLICY),
      id: `analyst-${threshold.toFixed(2)}-confidence-${confidence === null ? "off" : confidence.toFixed(2)}`,
      analyst: {
        yes: threshold,
        no: Number((1 - threshold).toFixed(2)),
        choiceProbability: threshold,
        choiceConfidence: confidence,
      },
    })),
  );
}

export function errorCode(error: unknown): string {
  if (error instanceof CacheMissError) return `cache_miss:${error.key}`;
  if (error instanceof GatewayRequestError)
    return `gateway_${error.status ?? "transport"}_${error.retryable ? "retryable" : "terminal"}`;
  return error instanceof Error
    ? String(sanitizeDiagnostic(`${error.name}:${error.message}`)).slice(0, 300)
    : "unknown_error";
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** A complete file is linked into place; an existing successful response always wins. */
export async function writeOnce<T>(path: string, value: T): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(temporary);
  }
  const committed = await readJson<T>(path);
  if (committed === null)
    throw new Error("Atomic file write did not produce a readable record.");
  return committed;
}

export async function replaceJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, path);
}

export class CacheMissError extends Error {
  constructor(readonly key: string) {
    super(`No frozen judgment exists for request ${key}.`);
    this.name = "CacheMissError";
  }
}

type CacheRecord = {
  version: 1;
  key: string;
  model: typeof JEV_MODEL;
  request: EvaluationRequest;
  evaluation: Evaluation;
  recordedAt: string;
};
export type CacheStats = {
  hits: number;
  calls: number;
  retries: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  missing: number;
  reused: number;
};
export type RequestEvent = {
  key: string;
  attempt: number;
  elapsedMs: number;
  status: "success" | "error";
  error?: string;
};

/** Cache keys deliberately exclude policy: an unchanged question is never rerolled. */
export class JudgmentCache {
  readonly stats: CacheStats = {
    hits: 0,
    calls: 0,
    retries: 0,
    failedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    missing: 0,
    reused: 0,
  };
  readonly events: RequestEvent[] = [];
  readonly protocolDiagnostics: unknown[] = [];
  readonly usedKeys = new Set<string>();
  private readonly inflight = new Map<string, Promise<Evaluation>>();
  private readonly failures = new Map<string, unknown>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly deadline: number;

  constructor(
    private readonly options: {
      directory: string;
      live: boolean;
      maxCalls: number;
      timeoutMs: number;
      concurrency: number;
      retries: number;
      provider?: Evaluate;
      reuseDirectories?: string[];
    },
  ) {
    this.deadline = Date.now() + options.timeoutMs;
  }

  get remainingMs() {
    return Math.max(0, this.deadline - Date.now());
  }

  /** Called at the HTTP boundary, before gateway JSON parsing and Jev validation. */
  async captureRawResponse(
    requestBody: string,
    response: Response,
  ): Promise<Response> {
    if (!response.ok) return response;
    const request = JSON.parse(requestBody) as EvaluationRequest & {
      model: string;
    };
    if (
      request.model !== JEV_MODEL ||
      !request.questions ||
      !("state" in request)
    )
      throw new Error("Unexpected raw evaluation request.");
    const key = createHash("sha256").update(requestBody).digest("hex");
    const raw = await writeOnce<RawHttpEvaluation>(
      join(this.options.directory, "raw-http", `${key}.json`),
      {
        version: 1,
        key,
        requestBody,
        status: response.status,
        responseBody: await response.clone().text(),
        recordedAt: new Date().toISOString(),
      },
    );
    if (raw.requestBody !== requestBody)
      throw new Error("Raw response request collision.");
    // First successful HTTP response wins even if the semantic/schema parser rejects it.
    return new Response(raw.responseBody, {
      status: raw.status,
      headers: { "content-type": "application/json" },
    });
  }

  private parseRaw(
    request: EvaluationRequest,
    raw: RawHttpEvaluation,
  ): Evaluation {
    try {
      return sanitizedEvaluation(
        request,
        parseEvaluation(request, JSON.parse(raw.responseBody)),
      );
    } catch (error) {
      this.protocolDiagnostics.push(diagnoseRawEvaluation(raw));
      throw error;
    }
  }

  readonly evaluate: Evaluate = async (request) => {
    const key = digest({ model: JEV_MODEL, ...request });
    this.usedKeys.add(key);
    if (this.failures.has(key)) throw this.failures.get(key);
    const existing = this.inflight.get(key);
    if (existing) {
      this.stats.hits++;
      return existing;
    }
    const pending = this.loadOrEvaluate(key, request);
    this.inflight.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      this.failures.set(key, error);
      throw error;
    } finally {
      this.inflight.delete(key);
    }
  };

  private async acquire(): Promise<void> {
    if (this.active < this.options.concurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  private async loadOrEvaluate(
    key: string,
    request: EvaluationRequest,
  ): Promise<Evaluation> {
    const path = join(this.options.directory, "judgments", `${key}.json`);
    // Read only a request that this experiment actually made. No directory scan,
    // old holdout labels or unrelated judgment keys are imported.
    if (
      !(await readJson(path)) &&
      !(await readRawEvaluation(this.options.directory, key))
    ) {
      for (const directory of this.options.reuseDirectories ?? []) {
        const source = await readJson<CacheRecord>(
          join(directory, "judgments", `${key}.json`),
        );
        const sourceRaw = await readRawEvaluation(directory, key);
        if (!source && !sourceRaw) continue;
        if (source) {
          if (
            source.version !== 1 ||
            source.key !== key ||
            source.model !== JEV_MODEL ||
            digest({ model: source.model, ...source.request }) !== key
          )
            throw new Error("Reused judgment identity failed validation.");
          const evaluation = sanitizedEvaluation(request, source.evaluation);
          await writeOnce(path, { ...source, evaluation });
        }
        if (sourceRaw)
          await writeOnce(
            join(this.options.directory, "raw-http", `${key}.json`),
            sourceRaw,
          );
        this.stats.reused++;
        break;
      }
    }
    const cached = await readJson<CacheRecord>(path);
    if (cached) {
      if (
        cached.version !== 1 ||
        cached.key !== key ||
        cached.model !== JEV_MODEL ||
        digest({ model: cached.model, ...cached.request }) !== key
      )
        throw new Error("Cached judgment identity failed validation.");
      this.stats.hits++;
      return sanitizedEvaluation(request, cached.evaluation);
    }
    const raw = await readRawEvaluation(this.options.directory, key);
    if (raw) {
      if (raw.requestBody !== JSON.stringify({ model: JEV_MODEL, ...request }))
        throw new Error("Raw request differs from the requested evaluation.");
      this.stats.hits++;
      const evaluation = this.parseRaw(request, raw);
      const committed = await writeOnce<CacheRecord>(path, {
        version: 1,
        key,
        model: JEV_MODEL,
        request,
        evaluation,
        recordedAt: raw.recordedAt,
      });
      return sanitizedEvaluation(request, committed.evaluation);
    }
    if (!this.options.live) {
      this.stats.missing++;
      throw new CacheMissError(key);
    }
    for (let attempt = 0; ; attempt++) {
      await this.acquire();
      let retryDelay: number | undefined;
      try {
        if (this.stats.calls >= this.options.maxCalls || !this.remainingMs)
          throw new GatewayRequestError(
            "Calibration request or deadline budget exhausted.",
            { retryable: false },
          );
        this.stats.calls++;
        if (attempt > 0) this.stats.retries++;
        const began = Date.now();
        let evaluation: Evaluation;
        try {
          evaluation = sanitizedEvaluation(
            request,
            await (this.options.provider ?? evaluateJev)(request),
          );
          this.events.push({
            key,
            attempt,
            elapsedMs: Date.now() - began,
            status: "success",
          });
        } catch (error) {
          const raw = await readRawEvaluation(this.options.directory, key);
          if (raw) this.protocolDiagnostics.push(diagnoseRawEvaluation(raw));
          this.stats.failedCalls++;
          this.events.push({
            key,
            attempt,
            elapsedMs: Date.now() - began,
            status: "error",
            error: errorCode(error),
          });
          throw error;
        }
        this.stats.inputTokens += evaluation.inputTokens ?? 0;
        this.stats.outputTokens += evaluation.outputTokens ?? 0;
        const committed = await writeOnce<CacheRecord>(path, {
          version: 1,
          key,
          model: JEV_MODEL,
          request,
          evaluation,
          recordedAt: new Date().toISOString(),
        });
        if (
          committed.key !== key ||
          digest({ model: committed.model, ...committed.request }) !== key
        )
          throw new Error(
            "Concurrent cached judgment identity failed validation.",
          );
        return sanitizedEvaluation(request, committed.evaluation);
      } catch (error) {
        // A captured 2xx response is final, even when invalid JSON/schema was labelled retryable upstream.
        if (await readRawEvaluation(this.options.directory, key)) throw error;
        if (
          !(error instanceof GatewayRequestError) ||
          !error.retryable ||
          attempt >= this.options.retries
        )
          throw error;
        retryDelay = Math.max(500 * 2 ** attempt, error.retryAfterMs ?? 0);
        if (retryDelay >= this.remainingMs) throw error;
      } finally {
        this.release();
      }
      if (retryDelay !== undefined) await delay(retryDelay);
    }
  }
}

export type AnalysisExpectation = {
  required: OperationKind[];
  allowed: OperationKind[];
  requiredLinks?: NonNullable<Finding["link"]>[];
  allowedLinks?: NonNullable<Finding["link"]>[];
};
export type AnalysisAssessment = {
  outcome:
    | "correct_positive"
    | "correct_negative"
    | "missed_positive"
    | "false_accept"
    | "error";
  expectedPositive: boolean;
  supportedKinds: OperationKind[];
  unexpectedKinds: OperationKind[];
  missingKinds: OperationKind[];
  unexpectedLinks: string[];
  missingLinks: string[];
  uncertainFindings: number;
};

function linkKey(link: NonNullable<Finding["link"]>) {
  return `${link.sourceId}|${link.type}|${link.targetId}`;
}

export function assessAnalysis(
  result: AnalysisResult,
  expected: AnalysisExpectation,
): AnalysisAssessment {
  const supported = result.findings.filter(
    (finding) => finding.status === "supported",
  );
  const supportedKinds = [...new Set(supported.map((finding) => finding.kind))];
  const supportedLinks = supported
    .filter((finding) => finding.kind === "add_link")
    .map((finding) =>
      finding.link ? linkKey(finding.link) : "invalid_missing_link",
    );
  const allowedLinks = new Set((expected.allowedLinks ?? []).map(linkKey));
  const unexpectedLinks = supportedLinks.filter(
    (key) => !allowedLinks.has(key),
  );
  const missingLinks = (expected.requiredLinks ?? [])
    .map(linkKey)
    .filter((key) => !supportedLinks.includes(key));
  const unexpectedKinds = supportedKinds.filter(
    (kind) => !expected.allowed.includes(kind),
  );
  const missingKinds = expected.required.filter(
    (kind) => !supportedKinds.includes(kind),
  );
  const expectedPositive =
    expected.required.length > 0 || (expected.requiredLinks?.length ?? 0) > 0;
  return {
    outcome:
      result.status !== "complete"
        ? "error"
        : unexpectedKinds.length || unexpectedLinks.length
          ? "false_accept"
          : missingKinds.length || missingLinks.length
            ? "missed_positive"
            : expectedPositive
              ? "correct_positive"
              : "correct_negative",
    expectedPositive,
    supportedKinds,
    unexpectedKinds,
    missingKinds,
    unexpectedLinks,
    missingLinks,
    uncertainFindings: result.findings.filter(
      (finding) => finding.status === "uncertain",
    ).length,
  };
}

export type VerifierSignals = {
  minima: Record<VerificationFamily, number | null>;
  questionCount: number;
  incomplete: boolean;
  deterministicRejected: boolean;
};

export function verifierSignals(verification: Verification): VerifierSignals {
  const minima: VerifierSignals["minima"] = {
    objective: null,
    integrity: null,
    link: null,
    conduct: null,
  };
  let questionCount = 0;
  let incomplete = !!verification.incomplete;
  for (const judgment of verification.judgments) {
    try {
      validateEvaluation(judgment, judgment);
    } catch {
      incomplete = true;
      continue;
    }
    for (const [id, answer] of Object.entries(judgment.answers)) {
      if (answer.type !== "boolean") {
        incomplete = true;
        continue;
      }
      questionCount++;
      const family = verificationFamily(id);
      minima[family] = Math.min(minima[family] ?? 1, answer.probability);
    }
  }
  const deterministicRejected =
    verification.status === "rejected" && !questionCount;
  if (!questionCount && !deterministicRejected) incomplete = true;
  return { minima, questionCount, incomplete, deterministicRejected };
}

export function classifyVerification(
  signals: VerifierSignals,
  policy: DecisionPolicy,
): Verification["status"] | "error" {
  if (signals.incomplete) return "error";
  if (signals.deterministicRejected) return "rejected";
  let uncertain = false;
  for (const [family, value] of Object.entries(signals.minima) as [
    VerificationFamily,
    number | null,
  ][]) {
    if (value === null) continue;
    if (value <= policy.verifier.reject) return "rejected";
    if (value < policy.verifier[family]) uncertain = true;
  }
  return uncertain ? "uncertain" : "accepted";
}

export function* verifierProfiles(): Generator<DecisionPolicy> {
  for (const objective of THRESHOLD_GRID)
    for (const integrity of THRESHOLD_GRID)
      for (const linkThreshold of THRESHOLD_GRID)
        for (const conduct of THRESHOLD_GRID)
          yield {
            ...structuredClone(SEED_DECISION_POLICY),
            id: `verifier-${objective}-${integrity}-${linkThreshold}-${conduct}`,
            verifier: {
              objective,
              integrity,
              link: linkThreshold,
              conduct,
              reject: SEED_DECISION_POLICY.verifier.reject,
            },
          };
}

export type Metrics = {
  total: number;
  eligible: number;
  errors: number;
  structuralRejected: number;
  trueAccept: number;
  falseAccept: number;
  missedPositive: number;
  safeNegative: number;
  uncertain: number;
};
export function emptyMetrics(): Metrics {
  return {
    total: 0,
    eligible: 0,
    errors: 0,
    structuralRejected: 0,
    trueAccept: 0,
    falseAccept: 0,
    missedPositive: 0,
    safeNegative: 0,
    uncertain: 0,
  };
}

export function compareVerifierConservatism(
  a: DecisionPolicy,
  b: DecisionPolicy,
): number {
  for (const family of ["integrity", "conduct", "link", "objective"] as const) {
    const difference = a.verifier[family] - b.verifier[family];
    if (difference) return difference;
  }
  return 0;
}

export function compareAnalystConservatism(
  a: DecisionPolicy,
  b: DecisionPolicy,
): number {
  const simpler =
    Number(a.analyst.choiceConfidence === null) -
    Number(b.analyst.choiceConfidence === null);
  return simpler || a.analyst.yes - b.analyst.yes;
}
