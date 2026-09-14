import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  appendSchema,
  contextSchema,
  EMBEDDING_DIMENSIONS,
  embeddingSchema,
  writeSchema,
} from "../lib/brain/schemas";
import { BrainError } from "../lib/brain/types";
import {
  assertOwner,
  assertVersion,
  normalizeIdentity,
  reciprocalRankScore,
  slugify,
} from "../lib/brain/utils";

const newPage = {
  title: "Project Atlas",
  type: "project",
  markdown: "# Atlas\n\nLaunch in October.",
  expectedVersion: 0,
};

test("a write requires an explicit creation or optimistic-update version", () => {
  assert.equal(writeSchema.parse(newPage).expectedVersion, 0);
  assert.equal(
    writeSchema.safeParse({ ...newPage, expectedVersion: undefined }).success,
    false,
  );
  assert.equal(
    writeSchema.safeParse({ ...newPage, expectedVersion: 1 }).success,
    false,
  );
  assert.equal(
    writeSchema.safeParse({ ...newPage, id: randomUUID() }).success,
    false,
  );
  assert.equal(
    writeSchema.safeParse({ ...newPage, id: randomUUID(), expectedVersion: 1 })
      .success,
    true,
  );
});

test("write inputs cannot smuggle ownership or untyped graph relations", () => {
  assert.equal(
    writeSchema.safeParse({ ...newPage, ownerId: "someone-else" }).success,
    false,
  );
  assert.equal(
    writeSchema.safeParse({
      ...newPage,
      links: [{ targetRef: "client/acme", type: "arbitrary" }],
    }).success,
    false,
  );
  assert.equal(
    writeSchema.safeParse({ ...newPage, slug: "../outside" }).success,
    false,
  );
});

test("embeddings must have the configured dimensions and a usable finite norm", () => {
  const valid = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) =>
    i === 0 ? 1 : 0,
  );
  assert.equal(embeddingSchema.safeParse(valid).success, true);
  assert.equal(embeddingSchema.safeParse(valid.slice(1)).success, false);
  assert.equal(
    embeddingSchema.safeParse(Array(EMBEDDING_DIMENSIONS).fill(0)).success,
    false,
  );
  assert.equal(
    embeddingSchema.safeParse([Number.NaN, ...valid.slice(1)]).success,
    false,
  );
  assert.equal(
    embeddingSchema.safeParse([Number.POSITIVE_INFINITY, ...valid.slice(1)])
      .success,
    false,
  );
  assert.equal(
    writeSchema.safeParse({ ...newPage, embedding: valid }).success,
    false,
  );
});

test("append and context enforce finite write/read budgets", () => {
  assert.equal(
    appendSchema.safeParse({
      ref: "project/atlas",
      markdown: "note",
      expectedVersion: 0,
    }).success,
    false,
  );
  assert.equal(
    appendSchema.safeParse({
      ref: "project/atlas",
      markdown: " ",
      expectedVersion: 1,
    }).success,
    false,
  );
  assert.equal(
    contextSchema.safeParse({ query: "Atlas", maxCharacters: 100_001 }).success,
    false,
  );
});

test("identity normalization catches Unicode width, case and whitespace duplicates", () => {
  assert.equal(normalizeIdentity("  ACME\t  Labs "), "acme labs");
  assert.equal(normalizeIdentity("Ａｃｍｅ"), normalizeIdentity("Acme"));
  assert.equal(slugify("Décision: Été 2026"), "decision-ete-2026");
});

test("missing owner and stale versions are explicit errors with recovery information", () => {
  assert.throws(
    () => assertOwner(" "),
    (error) => error instanceof BrainError && error.status === 401,
  );
  assert.throws(
    () => assertVersion(7, 6),
    (error) =>
      error instanceof BrainError &&
      error.code === "VERSION_CONFLICT" &&
      error.status === 409,
  );
  assert.doesNotThrow(() => assertVersion(7, 7));
});

test("RRF rewards agreement across retrieval rankings rather than incompatible raw scores", () => {
  assert.ok(reciprocalRankScore(2, 2) > reciprocalRankScore(1, null));
  assert.equal(reciprocalRankScore(null, 1), reciprocalRankScore(1, null));
  assert.equal(reciprocalRankScore(null, null), 0);
});
