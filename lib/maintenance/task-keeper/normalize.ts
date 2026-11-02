export function normalizeForFingerprint(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("it")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
