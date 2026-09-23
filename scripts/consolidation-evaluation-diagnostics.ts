import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const USAGE_FIELDS = [
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "input_tokens",
  "output_tokens",
  "cached_tokens",
  "reasoning_tokens",
  "cost",
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function visibleResponse(payload: unknown) {
  const body = record(payload);
  const choice = record(
    Array.isArray(body?.choices) ? body.choices[0] : undefined,
  );
  const message = record(choice?.message);
  const usage = record(body?.usage);
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    message: { content: text(message?.content) },
    finish_reason: text(choice?.finish_reason),
    model: text(body?.model),
    id: text(body?.id),
    usage: Object.fromEntries(
      USAGE_FIELDS.flatMap((key) => {
        const value = usage?.[key];
        return typeof value === "number" && Number.isFinite(value) && value >= 0
          ? [[key, value]]
          : [];
      }),
    ),
  };
}

/** Experimental failure capture; never retries or changes the evaluator result. */
export async function withKimiFailureDiagnostic<T>(
  path: string,
  invoke: (send: typeof fetch) => Promise<T>,
  send: typeof fetch = fetch,
): Promise<T> {
  const destination = resolve(path);
  const privateRoot = resolve("artifacts/consolidation");
  if (!destination.startsWith(`${privateRoot}${sep}`)) {
    throw new Error(
      "Kimi diagnostics must remain in private ignored artifacts.",
    );
  }
  let captured: ReturnType<typeof visibleResponse> | undefined;
  const capture: typeof fetch = async (url, init) => {
    const response = await send(url, init);
    try {
      captured = visibleResponse(await response.clone().json());
    } catch {
      // A non-JSON response has no structured visible completion to retain.
    }
    return response;
  };
  try {
    return await invoke(capture);
  } catch (error) {
    if (captured) {
      try {
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, `${JSON.stringify(captured, null, 2)}\n`, {
          flag: "wx",
          mode: 0o600,
        });
      } catch {
        // A diagnostic write failure must not replace the evaluator failure.
      }
    }
    throw error;
  }
}
