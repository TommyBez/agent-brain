import { getPool, transaction } from "../../db";
import { type GatewayCall, gatewayRequest } from "../gateway";

export const DAILY_BUDGET_NANO = 1_000_000_000;
export const EDITOR_MODEL = "deepseek/deepseek-v4.1-flash";
export const EDITOR_OUTPUT_TOKENS = 8192;
export class BudgetExhaustedError extends Error {
  constructor() {
    super("Daily consolidation budget exhausted");
  }
}

/** UTF-8 bytes plus framing reserve deliberately overestimate text tokenization. */
export function reserveCost(body: Record<string, unknown>): number {
  const input = Buffer.byteLength(JSON.stringify(body), "utf8") + 4096;
  if (body.model === "typesafe-ai/jev") return input * 42;
  if (body.model === EDITOR_MODEL)
    return input * 300 + EDITOR_OUTPUT_TOKENS * 1200;
  throw new Error("Unpriced consolidation model");
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function actualCost(raw: unknown, model: string): number | null {
  const response = object(raw);
  const gateway = object(object(response.providerMetadata).gateway);
  const usage = object(response.usage);
  const cost = gateway.cost ?? usage.cost;
  if (
    (typeof cost === "number" ||
      (typeof cost === "string" && cost.trim() !== "")) &&
    Number.isFinite(Number(cost)) &&
    Number(cost) >= 0
  )
    return Math.ceil(Number(cost) * 1e9);
  const input = usage.inputTokens ?? usage.prompt_tokens;
  const output = usage.outputTokens ?? usage.completion_tokens;
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0)
    return null;
  if (model === "typesafe-ai/jev") return Math.ceil(input * 42);
  if (
    model === EDITOR_MODEL &&
    typeof output === "number" &&
    Number.isFinite(output) &&
    output >= 0
  )
    return Math.ceil(input * 300 + output * 1200);
  return null;
}

/** Global UTC-day ceiling, shared by owners, workflows, physical attempts and retries. */
export async function reserveSpend(
  ownerId: string,
  runId: string,
  model: string,
  amount: number,
): Promise<string> {
  return transaction(async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('consolidation-daily-spend'))",
    );
    const spent = await db.query<{ spent: string }>(
      `SELECT COALESCE(sum(COALESCE(actual_nano,reserved_nano)),0)::text AS spent FROM brain_consolidation_spend WHERE day=(now() AT TIME ZONE 'UTC')::date`,
    );
    if (Number(spent.rows[0].spent) + amount > DAILY_BUDGET_NANO)
      throw new BudgetExhaustedError();
    const result = await db.query<{ id: string }>(
      `INSERT INTO brain_consolidation_spend(owner_id,run_id,model,day,reserved_nano) VALUES ($1,$2,$3,(now() AT TIME ZONE 'UTC')::date,$4) RETURNING id`,
      [ownerId, runId, model, amount],
    );
    return result.rows[0].id;
  });
}

export function budgetedGateway(ownerId: string, runId: string): GatewayCall {
  return async <T>(
    path: Parameters<GatewayCall>[0],
    body: unknown,
  ): Promise<T> => {
    const request = object(body);
    const model = String(request.model);
    const id = await reserveSpend(ownerId, runId, model, reserveCost(request));
    // Unknown outcomes keep their reservation; a retry is another physical attempt.
    const response = await gatewayRequest<T>(path, body);
    const cost = actualCost(response, model);
    if (cost !== null)
      await getPool().query(
        "UPDATE brain_consolidation_spend SET actual_nano=$2 WHERE id=$1",
        [id, cost],
      );
    return response;
  };
}
