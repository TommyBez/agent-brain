import { allowedEmails } from "../auth";
import type { Database } from "../brain/pages";
import { dailyBudgetNano } from "../maintenance/consolidator/budget";
import type { GatewayCall } from "../maintenance/gateway";

export const SUGGESTION_POLICY = { deadlineMs: 8_000 } as const;
export type FallbackReason =
  | "budget"
  | "budget_unavailable"
  | "deadline"
  | "gateway"
  | "context";
export interface SuggestionOptions {
  signal?: AbortSignal;
  skipReason?: FallbackReason;
  onFallback?: (value: unknown) => void;
}

/** No reservation or spend insert: only read the existing pooled UTC-day cap. */
export async function suggestionBudgetAvailable(
  db: Database,
): Promise<boolean> {
  const { rows } = await db.query<{ spent_nano: string; accounts: number }>(
    `SELECT COALESCE(sum(actual_nano), 0)::text AS spent_nano,
       (SELECT count(*)::int FROM "user" WHERE lower(email) = ANY($1::text[])) AS accounts
     FROM brain_consolidation_spend WHERE day = (now() AT TIME ZONE 'UTC')::date`,
    [allowedEmails()],
  );
  return (
    Number(rows[0]?.spent_nano ?? 0) <
    dailyBudgetNano(Number(rows[0]?.accounts ?? 0))
  );
}

export async function withinSuggestionDeadline<T>(
  initial: T,
  work: (signal: AbortSignal, fallback: (value: T) => void) => Promise<T>,
  ms: number = SUGGESTION_POLICY.deadlineMs,
): Promise<T> {
  const controller = new AbortController();
  let fallback = initial;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(fallback);
    }, ms);
  });
  try {
    return await Promise.race([
      work(controller.signal, (value) => {
        if (!controller.signal.aborted) fallback = value;
      }),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** A fake send may ignore signals: still stop waiting at the same overall deadline. */
export function abortableSuggestionSend(
  send: GatewayCall,
  signal: AbortSignal,
): GatewayCall {
  return async <T>(
    path: Parameters<GatewayCall>[0],
    body: unknown,
  ): Promise<T> => {
    signal.throwIfAborted();
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([send<T>(path, body, { signal }), cancelled]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
}
