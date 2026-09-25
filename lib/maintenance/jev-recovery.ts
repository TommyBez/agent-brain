import { GatewayRequestError } from "./gateway";
import type { ConsolidationEvaluation, JevTransportFailure } from "./jev";

export const JEV_RECOVERY = {
  maxAttempts: 5,
  totalTimeoutMs: 30_000,
  backoffMs: [500, 1_500, 3_000, 6_000],
  retry: "explicit HTTP 408, 429 or 5xx only; never a model judgment",
} as const;

export class JevRecoveryError extends GatewayRequestError {
  constructor(readonly transportFailures: JevTransportFailure[]) {
    const last = transportFailures.at(-1) ?? {
      status: null,
      retryable: false,
      retryAfterMs: null,
    };
    super("Jev exhausted its bounded transport recovery.", {
      retryable: last.retryable,
      ...(last.status === null ? {} : { status: last.status }),
      retryAfterMs: last.retryAfterMs,
    });
  }
}

function explicitHttpFailure(error: unknown): JevTransportFailure | null {
  const candidate =
    error instanceof GatewayRequestError
      ? error
      : error && typeof error === "object" && "diagnostic" in error
        ? error.diagnostic
        : null;
  if (!candidate || typeof candidate !== "object" || !("status" in candidate))
    return null;
  const status = candidate.status;
  if (typeof status !== "number" || status < 400 || status > 599) return null;
  const retryable =
    "retryable" in candidate &&
    candidate.retryable === true &&
    (status === 408 || status === 429 || status >= 500);
  const delay = "retryAfterMs" in candidate ? candidate.retryAfterMs : null;
  return {
    status,
    retryable,
    retryAfterMs:
      typeof delay === "number" && Number.isFinite(delay) && delay >= 0
        ? delay
        : null,
  };
}

/** Recovery repeats only a known failed HTTP request, never a returned judgment. */
export async function recoverJevTransport(
  request: (
    attempt: number,
    timeoutMs: number,
  ) => Promise<ConsolidationEvaluation>,
  options: {
    wait?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<ConsolidationEvaluation> {
  const now = options.now ?? Date.now;
  const wait =
    options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + JEV_RECOVERY.totalTimeoutMs;
  const failures: JevTransportFailure[] = [];
  for (let attempt = 1; attempt <= JEV_RECOVERY.maxAttempts; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new JevRecoveryError(failures);
    try {
      const result = await request(attempt, remaining);
      return failures.length
        ? { ...result, transportFailures: failures }
        : result;
    } catch (error) {
      const failure = explicitHttpFailure(error);
      if (!failure) {
        if (!failures.length) throw error;
        // The last request has no valid judgment or known billable usage.
        failures.push({ status: null, retryable: false, retryAfterMs: null });
        throw new JevRecoveryError(failures);
      }
      failures.push(failure);
      const delay = Math.max(
        JEV_RECOVERY.backoffMs[attempt - 1] ?? 0,
        failure.retryAfterMs ?? 0,
      );
      if (
        !failure.retryable ||
        attempt === JEV_RECOVERY.maxAttempts ||
        now() + delay + 1_000 >= deadline
      )
        throw new JevRecoveryError(failures);
      await wait(delay);
    }
  }
  throw new JevRecoveryError(failures);
}
