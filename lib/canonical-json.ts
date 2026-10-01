import { createHash } from "node:crypto";

/** Canonical object keys, with JSON's native arrays, dates and undefined semantics. */
export function canonicalJson(value: unknown, indent?: number): string {
  const encoded = JSON.stringify(
    value,
    (_key, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
    indent,
  );
  if (encoded === undefined)
    throw new TypeError("Value must be JSON serializable");
  return encoded;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
