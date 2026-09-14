import { BrainError } from "./types";

export function normalizeIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 160)
    .replace(/-$/, "");
}

export function assertOwner(ownerId: string) {
  if (!ownerId?.trim())
    throw new BrainError(
      "UNAUTHORIZED",
      "An authenticated owner is required",
      401,
    );
}

export function assertVersion(actual: number, expected: number) {
  if (actual !== expected)
    throw new BrainError(
      "VERSION_CONFLICT",
      "This page changed after it was read. Read it again and reconcile your changes.",
      409,
      { expectedVersion: expected, currentVersion: actual },
    );
}

export function vectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

export function embeddingModel(): string {
  return process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small";
}

export function assertEmbeddingModel(
  model: string | undefined,
  hasEmbedding: boolean,
) {
  if (hasEmbedding && model !== embeddingModel())
    throw new BrainError(
      "EMBEDDING_MODEL_MISMATCH",
      `Use the configured embedding model: ${embeddingModel()}`,
      400,
    );
}

/** Weighted reciprocal rank fusion. Rankings are one-based; k=60 is intentional. */
export function reciprocalRankScore(
  textRank?: number | null,
  vectorRank?: number | null,
): number {
  return (
    (textRank ? 1 / (60 + textRank) : 0) +
    (vectorRank ? 1 / (60 + vectorRank) : 0)
  );
}
