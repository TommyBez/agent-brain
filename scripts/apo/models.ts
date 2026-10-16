import { fingerprint } from "../../lib/canonical-json";
import {
  JEV_MODEL,
  JevResponseError,
  parseEvaluation,
} from "../../lib/maintenance/consolidator/jev";
import {
  type GatewayCall,
  GatewayRequestError,
  gatewayRequest,
} from "../../lib/maintenance/gateway";
import type { CallRecord, ExperimentStore, Manifest } from "./store";
import { usage } from "./store";
import type { DecisionModel } from "./types";

export class BudgetStop extends Error {
  constructor() {
    super("Experiment budget reached");
  }
}
const object = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
const nonnegative = (value: unknown) =>
  (typeof value === "number" || typeof value === "string") &&
  value !== "" &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0
    ? Number(value)
    : undefined;
export function providerUsage(raw: unknown) {
  const response = object(raw);
  const u = object(response.usage);
  const gateway = object(object(response.providerMetadata).gateway);
  return {
    inputTokens: nonnegative(u.inputTokens ?? u.prompt_tokens),
    outputTokens: nonnegative(u.outputTokens ?? u.completion_tokens),
    costDollars: nonnegative(gateway.cost ?? u.cost),
  };
}
export function safeFailure(error: unknown) {
  return error instanceof GatewayRequestError
    ? error.reason
    : error instanceof JevResponseError
      ? `invalid_evaluation_response:${error.reason}`
      : "invalid_model_response";
}

/** Persist a reservation BEFORE each physical call. Unknown outcomes remain charged. */
export class ModelAdapter {
  final = false;
  private ledger: CallRecord[] | undefined;
  private reservationQueue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly store: ExperimentStore,
    readonly manifest: Manifest,
    readonly send: GatewayCall = gatewayRequest,
  ) {}
  private async reserve(
    path: Parameters<GatewayCall>[0],
    body: Record<string, unknown>,
    logicalId: string,
  ) {
    const id = fingerprint(logicalId);
    const name = `calls/${id}.json`;
    const requestHash = fingerprint({ path, body });
    const previous = await this.store.maybe<CallRecord>(name);
    if (previous) {
      if (previous.requestHash !== requestHash)
        throw new Error("Resumed call changed");
      if (previous.status !== "complete")
        throw new GatewayRequestError(
          "Previous call failed or has an unknown outcome; no automatic duplicate charge.",
          { retryable: false, reason: "transport" },
        );
      return { cached: true as const, record: previous, name, info: undefined };
    }
    const model = String(body.model);
    const info = this.manifest.models.find((m) => m.id === model);
    if (!info) throw new Error("Missing model pricing snapshot");
    // UTF-8 bytes dominate supported tokenizer counts; reserve overhead as well.
    const input = Buffer.byteLength(JSON.stringify(body), "utf8") * 2 + 4096;
    const output = path === "evaluate" ? 0 : Number(body.max_tokens);
    if (!Number.isSafeInteger(output) || output < 0)
      throw new Error("Missing bounded output");
    const reservedTokens = input + output;
    const reservedDollars =
      input * Number(info.pricing.input) + output * Number(info.pricing.output);
    this.ledger ??= await this.store.calls();
    const current = usage(this.ledger);
    const config = this.manifest.config;
    // Keep 30% for the once-only held-out comparison, including baseline.
    const portion = this.final ? 1 : 0.7;
    if (
      current.calls + 1 > config.maxCalls * portion ||
      current.tokens + reservedTokens > config.maxTokens * portion ||
      current.dollars + reservedDollars > config.maxDollars * portion
    )
      throw new BudgetStop();
    const record: CallRecord = {
      id,
      status: "started",
      requestHash,
      model,
      reservedTokens,
      reservedDollars,
    };
    await this.store.write(name, record, true);
    this.ledger.push(record);
    return { cached: false as const, record, name, info };
  }
  async call(
    path: Parameters<GatewayCall>[0],
    body: Record<string, unknown>,
    logicalId: string,
  ) {
    // Serialize reservations, not network requests: in-flight calls count against all caps.
    const pending = this.reservationQueue.then(() =>
      this.reserve(path, body, logicalId),
    );
    this.reservationQueue = pending.catch(() => undefined);
    const reserved = await pending;
    const { record, name } = reserved;
    if (reserved.cached) return { response: record.response, record };
    const info = reserved.info;
    const started = performance.now();
    try {
      const response = await this.send<unknown>(path, body);
      const measured = providerUsage(response);
      Object.assign(record, {
        status: "complete",
        latencyMs: performance.now() - started,
        response,
        ...measured,
        costSource: measured.costDollars === undefined ? "catalog" : "provider",
      });
      if (
        record.costDollars === undefined &&
        measured.inputTokens !== undefined &&
        measured.outputTokens !== undefined
      )
        record.costDollars =
          measured.inputTokens * Number(info.pricing.input) +
          measured.outputTokens * Number(info.pricing.output);
      await this.store.write(name, record);
      return { response, record };
    } catch (error) {
      Object.assign(record, {
        status: "error",
        error: safeFailure(error),
        latencyMs: performance.now() - started,
      });
      await this.store.write(name, record);
      throw error;
    }
  }
  decision: DecisionModel = async (request, callId) => {
    const { response, record } = await this.call(
      "evaluate",
      { model: this.manifest.decisionModel, ...request },
      callId,
    );
    const parsed = parseEvaluation(request, response);
    // No fallback model may silently enter the comparison.
    if (parsed.model !== this.manifest.decisionModel)
      throw new Error("Decision model changed");
    return {
      answer: parsed.answers.decision,
      model: parsed.model,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      costDollars: record.costDollars ?? null,
      latencyMs: record.latencyMs,
    };
  };
}

export function validateCatalog(
  raw: unknown,
  optimizer: string,
  judges: string[] = [],
) {
  const data = object(raw).data;
  if (!Array.isArray(data)) throw new Error("Invalid model catalog");
  return [...new Set([JEV_MODEL, optimizer, ...judges])].map((id) => {
    const model = data.map(object).find((m) => m.id === id);
    const pricing = object(model?.pricing);
    if (
      !model ||
      nonnegative(pricing.input) === undefined ||
      nonnegative(pricing.output) === undefined
    )
      throw new Error(`Model/pricing unavailable: ${id}`);
    if (id === JEV_MODEL && model.type !== "evaluation")
      throw new Error("Jev must support evaluation");
    if (
      id !== JEV_MODEL &&
      (model.type !== "language" ||
        !((model.supported_parameters ?? []) as string[]).includes(
          "response_format",
        ))
    )
      throw new Error("Language model must support structured generation");
    return {
      ...model,
      id,
      pricing: { input: String(pricing.input), output: String(pricing.output) },
    };
  });
}
