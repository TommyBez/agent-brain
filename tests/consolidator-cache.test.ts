import assert from "node:assert/strict";
import test from "node:test";
import { CAPACITY_POLICY_VERSION } from "../lib/maintenance/consolidator/capacity";
import { REPAIR_POLICY_VERSION } from "../lib/maintenance/consolidator/plan-validation";
import {
  canReuseAnalysis,
  canReuseDecision,
} from "../lib/maintenance/consolidator/reuse";
import {
  buildSnapshot,
  pageEvidenceFingerprint,
} from "../lib/maintenance/consolidator/snapshot";
import type { DecisionRecord } from "../lib/maintenance/consolidator/types";
import { page } from "./helpers/consolidator";

test("capacity blocks are reused only for the same evidence and capacity policy", () => {
  const a = page("a");
  const snapshot = buildSnapshot([a]);
  const dependencies = [
    { pageId: a.id, fingerprint: pageEvidenceFingerprint(a) },
  ];
  const result = {
    status: "incomplete" as const,
    dependencies,
    capacity: {
      version: CAPACITY_POLICY_VERSION,
      reason: "max_tokens_exceeded" as const,
    },
  };
  assert.equal(canReuseAnalysis(snapshot, result), true);
  assert.equal(
    canReuseAnalysis(
      buildSnapshot([{ ...a, markdown: "New evidence" }]),
      result,
    ),
    false,
  );
  assert.equal(
    canReuseAnalysis(snapshot, {
      ...result,
      capacity: { ...result.capacity, version: "old" },
    }),
    false,
  );
  const decision: DecisionRecord = {
    operationId: "op",
    status: "uncertain",
    reason: "capacity",
    capacityVersion: CAPACITY_POLICY_VERSION,
    evidenceFingerprints: dependencies,
  };
  assert.equal(canReuseDecision(snapshot, decision), true);
  assert.equal(
    canReuseDecision(snapshot, { ...decision, capacityVersion: undefined }),
    false,
  );
});

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
  const rejected = { ...decision, status: "rejected" as const };
  assert.equal(
    canReuseDecision(buildSnapshot([a, technical]), rejected),
    false,
  );
  assert.equal(
    canReuseDecision(buildSnapshot([a, technical]), {
      ...rejected,
      repairVersion: REPAIR_POLICY_VERSION,
    }),
    true,
  );
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
