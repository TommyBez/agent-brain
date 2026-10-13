import { retryAfterMilliseconds } from "../retry-after";

const GATEWAY_ORIGIN = "https://ai-gateway.vercel.sh/v1/";
const REQUEST_TIMEOUT_MS = 120_000;

/** Safe to persist in job diagnostics; provider response bodies are never included. */
export class GatewayRequestError extends Error {
  readonly reason: string;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    options: {
      reason?:
        | "configuration"
        | "transport"
        | "timeout"
        | "invalid_json"
        | "max_tokens_exceeded";
      retryable: boolean;
      status?: number;
      retryAfterMs?: number | null;
    },
  ) {
    super(message);
    this.name = "GatewayRequestError";
    this.reason =
      options.reason ??
      (options.status ? `http_${options.status}` : "transport");
    this.retryable = options.retryable;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

/** One bounded request. The durable workflow, rather than an in-memory loop, retries. */
export async function gatewayRequest<T>(
  path: "chat/completions" | "embeddings" | "evaluate",
  body: unknown,
): Promise<T> {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) {
    throw new GatewayRequestError(
      "AI_GATEWAY_API_KEY is required for nightly maintenance.",
      { retryable: false, reason: "configuration" },
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
  } catch (error) {
    throw new GatewayRequestError("AI Gateway request failed or timed out.", {
      reason:
        error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "transport",
      retryable: true,
    });
  }

  if (!response.ok) {
    // Extract only an allowlisted code; provider messages can echo private prompts.
    const reason =
      path === "evaluate" && response.status === 400
        ? await evaluationFailureReason(response)
        : undefined;
    await response.body?.cancel().catch(() => undefined);
    throw new GatewayRequestError(
      `AI Gateway returned HTTP ${response.status}.`,
      {
        reason,
        retryable:
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500,
        status: response.status,
        retryAfterMs: boundedRetryAfter(response.headers.get("retry-after")),
      },
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new GatewayRequestError("AI Gateway returned invalid JSON.", {
      reason: "invalid_json",
      retryable: true,
    });
  }
}

export type GatewayCall = typeof gatewayRequest;

async function evaluationFailureReason(
  response: Response,
): Promise<"max_tokens_exceeded" | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 64 * 1024) return;
      chunks.push(value);
    }
    const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const attempts = raw?.providerMetadata?.gateway?.routing?.modelAttempts;
    if (!Array.isArray(attempts)) return;
    for (const model of attempts) {
      if (!Array.isArray(model?.providerAttempts)) continue;
      for (const attempt of model.providerAttempts) {
        if (attempt?.provider !== "typesafe-ai" || attempt.statusCode !== 400)
          continue;
        try {
          if (JSON.parse(attempt.error)?.error_type === "max_tokens_exceeded")
            return "max_tokens_exceeded";
        } catch {
          // Other providers may return plain text. Never persist it.
        }
      }
    }
  } catch {
    // A missing or malformed body leaves the original HTTP diagnostic intact.
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function boundedRetryAfter(value: string | null) {
  const delay = retryAfterMilliseconds(value);
  return delay === null ? null : Math.min(delay, 15 * 60_000);
}
