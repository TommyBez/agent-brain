/** Safe diagnostics survive Workflow error serialization without storing prompts or SQL. */
export type FailureDiagnostic = {
  category: "jev" | "gateway" | "database" | "internal";
  code: string;
  retryable: boolean;
};

export function failureDiagnostic(error: unknown): FailureDiagnostic {
  if (!(error instanceof Error))
    return { category: "internal", code: "unknown", retryable: false };
  const encoded = error.message.match(
    /Consolidation failure \[(jev|gateway|database|internal):([A-Za-z0-9_]+):(retry|fatal)\]/,
  );
  if (encoded)
    return {
      category: encoded[1] as FailureDiagnostic["category"],
      code: encoded[2],
      retryable: encoded[3] === "retry",
    };
  if (error.name === "JevResponseError" && "reason" in error)
    return { category: "jev", code: String(error.reason), retryable: false };
  if (error.name === "GatewayRequestError" && "status" in error)
    return {
      category: "gateway",
      code: "reason" in error ? String(error.reason) : "transport",
      retryable: "retryable" in error && error.retryable === true,
    };
  const code = "code" in error ? error.code : undefined;
  if (
    typeof code === "string" &&
    /^(?:[0-9A-Z]{5}|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE)$/.test(code)
  )
    return {
      category: "database",
      code,
      retryable:
        /^08/.test(code) ||
        [
          "40001",
          "40P01",
          "53300",
          "57P01",
          "57P02",
          "57P03",
          "ECONNRESET",
          "ECONNREFUSED",
          "ETIMEDOUT",
          "EPIPE",
        ].includes(code),
    };
  if (error.cause) return failureDiagnostic(error.cause);
  return {
    category: "internal",
    code: ["TypeError", "SyntaxError", "RangeError"].includes(error.name)
      ? error.name
      : "unknown",
    retryable: false,
  };
}

export function failureMessage(diagnostic: FailureDiagnostic): string {
  return `Consolidation failure [${diagnostic.category}:${diagnostic.code}:${diagnostic.retryable ? "retry" : "fatal"}]`;
}
