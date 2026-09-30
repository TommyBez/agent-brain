import { getPool } from "../../db";
import { type GatewayCall, gatewayRequest } from "../gateway";

export const DAILY_BUDGET_NANO = 1_000_000_000;
export const EDITOR_MODEL = "deepseek/deepseek-v4.1-flash";
export class BudgetExhaustedError extends Error {
  constructor() {
    super("Daily consolidation budget exhausted");
  }
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

/** Start a physical attempt while recorded UTC-day spend is below the target.
 * In-flight and unknown costs do not reserve credit; a completed call may overshoot.
 */
export async function startSpend(
  ownerId: string,
  runId: string,
  model: string,
): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO brain_consolidation_spend(owner_id,run_id,model,day)
     SELECT $1,$2,$3,(now() AT TIME ZONE 'UTC')::date
     WHERE (SELECT COALESCE(sum(actual_nano),0) FROM brain_consolidation_spend
            WHERE day=(now() AT TIME ZONE 'UTC')::date) < $4
     RETURNING id`,
    [ownerId, runId, model, DAILY_BUDGET_NANO],
  );
  if (!result.rows.length) throw new BudgetExhaustedError();
  return result.rows[0].id;
}

export function budgetedGateway(ownerId: string, runId: string): GatewayCall {
  return async <T>(
    path: Parameters<GatewayCall>[0],
    body: unknown,
  ): Promise<T> => {
    const model = String(object(body).model);
    const id = await startSpend(ownerId, runId, model);
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
