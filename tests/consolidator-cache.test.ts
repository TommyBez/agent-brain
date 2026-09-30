import assert from "node:assert/strict";
import test from "node:test";
import {
  canReuseAnalysis,
  canReuseDecision,
} from "../lib/maintenance/consolidator/cache";
import {
  buildSnapshot,
  pageEvidenceFingerprint,
} from "../lib/maintenance/consolidator/snapshot";
import type { DecisionRecord } from "../lib/maintenance/consolidator/types";
import { page } from "./helpers/consolidator";

test("analysis dependencies are scoped to actual evidence, not the whole corpus", () => {
  const a = page("a"),
    source = page("source"),
    unrelated = page("unrelated");
  const result = {
    status: "complete" as const,
    dependencies: [a, source].map((page) => ({
      pageId: page.id,
      fingerprint: pageEvidenceFingerprint(page),
    })),
  };
  assert.equal(
    canReuseAnalysis(
      buildSnapshot([a, source, { ...unrelated, markdown: "Changed." }]),
      result,
    ),
    true,
  );
  assert.equal(
    canReuseAnalysis(
      buildSnapshot([
        a,
        { ...source, markdown: "Corrected source." },
        unrelated,
      ]),
      result,
    ),
    false,
  );
  assert.equal(canReuseAnalysis(buildSnapshot([a, unrelated]), result), false);
  assert.equal(
    canReuseAnalysis(buildSnapshot([a, source]), {
      ...result,
      status: "incomplete",
    }),
    false,
  );
});

test("terminal decisions survive technical revisions but not changed semantic evidence", () => {
  const a = page("a"),
    source = page("source");
  const decision: DecisionRecord = {
    operationId: "plan",
    status: "uncertain",
    evidenceFingerprints: [a, source].map((page) => ({
      pageId: page.id,
      fingerprint: pageEvidenceFingerprint(page),
    })),
  };
  const technical = {
    ...source,
    version: 2,
    updatedAt: "2026-10-01",
    embeddedAt: "2026-10-01",
  };
  assert.equal(canReuseDecision(buildSnapshot([a, technical]), decision), true);
  assert.equal(
    canReuseDecision(
      buildSnapshot([a, { ...technical, markdown: "New fact." }]),
      decision,
    ),
    false,
  );
  assert.equal(canReuseDecision(buildSnapshot([a]), decision), false);
  assert.equal(
    canReuseDecision(buildSnapshot([a, source]), {
      ...decision,
      status: "error",
    }),
    false,
  );
});
