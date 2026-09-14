const GATEWAY_ORIGIN = "https://ai-gateway.vercel.sh/v1/";
const REQUEST_TIMEOUT_MS = 120_000;

/** Safe to persist in job diagnostics; provider response bodies are never included. */
export class GatewayRequestError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    options: {
      retryable: boolean;
      status?: number;
      retryAfterMs?: number | null;
    },
  ) {
    super(message);
    this.name = "GatewayRequestError";
    this.retryable = options.retryable;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

function retryAfterMilliseconds(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? Math.min(milliseconds, 15 * 60_000)
    : null;
}

/** One bounded request. The durable workflow, rather than an in-memory loop, retries. */
export async function gatewayRequest<T>(
  path: "chat/completions" | "embeddings",
  body: unknown,
): Promise<T> {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) {
    throw new GatewayRequestError(
      "AI_GATEWAY_API_KEY is required for nightly maintenance.",
      { retryable: false },
    );
  }

  let response: Response;
  try {
    response = await fetch(`${GATEWAY_ORIGIN}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GatewayRequestError("AI Gateway request failed or timed out.", {
      retryable: true,
    });
  }

  if (!response.ok) {
    // Neither credentials nor provider errors (which can echo private prompts)
    // belong in workflow error messages or operational logs.
    await response.body?.cancel().catch(() => undefined);
    throw new GatewayRequestError(
      `AI Gateway returned HTTP ${response.status}.`,
      {
        retryable:
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500,
        status: response.status,
        retryAfterMs: retryAfterMilliseconds(
          response.headers.get("retry-after"),
        ),
      },
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new GatewayRequestError("AI Gateway returned invalid JSON.", {
      retryable: true,
    });
  }
}
