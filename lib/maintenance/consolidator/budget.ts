import { allowedEmails } from "../../auth";
import { getPool } from "../../db";
import {
  SPEND_PURPOSES,
  type SpendPurpose,
  tasksEnabled,
} from "../../tasks/types";
import { type GatewayCall, gatewayRequest } from "../gateway";

export const DAILY_BUDGET_NANO = 1_000_000_000;

export function dailyBudgetNano(accountCount: number) {
  if (!Number.isSafeInteger(accountCount) || accountCount < 1) return 0;
  return DAILY_BUDGET_NANO * accountCount;
}

/** Soft caps inside the pooled daily cap, in tenths (§8.4). */
export const SPEND_SHARE_TENTHS = { pages: 9, tasks: 1 } as const;
/** The nightly task phases share one quota. */
export const TASK_SPEND_PURPOSES: readonly SpendPurpose[] = [
  "task_keeper",
  "task_links",
];

/** Purposes whose recorded spend counts against `purpose`'s soft cap. */
export function spendPurposeGroup(
  purpose: SpendPurpose,
): readonly SpendPurpose[] {
  return purpose === "pages" ? ["pages"] : TASK_SPEND_PURPOSES;
}

/** Without the task release no task phase runs, so pages keep the whole cap. */
export function purposeBudgetNano(
  purpose: SpendPurpose,
  accountCount: number,
  tasks = tasksEnabled(),
) {
  const tenth = dailyBudgetNano(accountCount) / 10;
  if (purpose !== "pages") return tenth * SPEND_SHARE_TENTHS.tasks;
  return tenth * (tasks ? SPEND_SHARE_TENTHS.pages : 10);
}

export async function presentAccountCount() {
  const emails = allowedEmails();
  if (!emails.length) return 0;
  const { rows } = await getPool().query<{ count: number }>(
    `SELECT count(*)::int AS count FROM "user" WHERE lower(email) = ANY($1::text[])`,
    [emails],
  );
  return rows[0]?.count ?? 0;
}
export const EDITOR_MODEL = "deepseek/deepseek-v4.1-flash-1017";
export class BudgetExhaustedError extends Error {
  constructor(readonly purpose: SpendPurpose = "pages") {
    super(
      purpose === "pages"
        ? "Daily consolidation budget exhausted"
        : "Daily task maintenance budget exhausted",
    );
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
  if (model === "typesafe-ai/jev" || model === "typesafe-ai/jev-1.14.0")
    return Math.ceil(input * 42);
  if (
    model === EDITOR_MODEL &&
    typeof output === "number" &&
    Number.isFinite(output) &&
    output >= 0
  )
    return Math.ceil(input * 150 + output * 600);
  return null;
}

/** Start a physical attempt while recorded UTC-day spend is below the target.
 * The target is one dollar for each allowlisted account that exists, shared by
 * every owner; the purpose's soft cap applies inside it.
 * In-flight and unknown costs do not reserve credit; a completed call may overshoot.
 */
export async function startSpend(
  ownerId: string,
  runId: string,
  model: string,
  purpose: SpendPurpose = "pages",
): Promise<string> {
  if (!SPEND_PURPOSES.includes(purpose))
    throw new Error("Unknown spending purpose");
  const accounts = await presentAccountCount();
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO brain_consolidation_spend(owner_id,run_id,model,day,purpose)
     SELECT $1,$2,$3,(now() AT TIME ZONE 'UTC')::date,$4
     WHERE (SELECT COALESCE(sum(actual_nano),0) FROM brain_consolidation_spend
            WHERE day=(now() AT TIME ZONE 'UTC')::date) < $5
       AND (SELECT COALESCE(sum(actual_nano),0) FROM brain_consolidation_spend
            WHERE day=(now() AT TIME ZONE 'UTC')::date
              AND purpose=ANY($6::text[])) < $7
     RETURNING id`,
    [
      ownerId,
      runId,
      model,
      purpose,
      dailyBudgetNano(accounts),
      spendPurposeGroup(purpose),
      purposeBudgetNano(purpose, accounts),
    ],
  );
  if (!result.rows.length) throw new BudgetExhaustedError(purpose);
  return result.rows[0].id;
}

/** Known cost of one run's calls for these purposes; unknown costs count as zero. */
export async function recordedSpendNano(
  ownerId: string,
  runId: string,
  purposes: readonly SpendPurpose[],
): Promise<number> {
  const { rows } = await getPool().query<{ total: string }>(
    `SELECT COALESCE(sum(actual_nano),0)::text AS total FROM brain_consolidation_spend
     WHERE owner_id=$1 AND run_id=$2 AND purpose=ANY($3::text[])`,
    [ownerId, runId, purposes],
  );
  return Number(rows[0]?.total ?? 0);
}

export function budgetedGateway(
  ownerId: string,
  runId: string,
  purpose: SpendPurpose = "pages",
): GatewayCall {
  return async <T>(
    path: Parameters<GatewayCall>[0],
    body: unknown,
  ): Promise<T> => {
    const model = String(object(body).model);
    const id = await startSpend(ownerId, runId, model, purpose);
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
