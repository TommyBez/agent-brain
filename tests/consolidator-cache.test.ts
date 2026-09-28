import assert from "node:assert/strict";
import test from "node:test";
import type { BrainPage } from "../lib/brain/types";
import {
  canReuseAnalysis,
  canReuseDecision,
} from "../lib/maintenance/consolidator/cache";
import { buildSnapshot } from "../lib/maintenance/consolidator/snapshot";
import type { DecisionRecord } from "../lib/maintenance/consolidator/types";

function page(id: string): BrainPage {
  return {
    id,
    slug: id,
    title: id,
    type: "note",
    markdown: `Fatto ${id}.`,
    summary: "",
    aliases: [],
    tags: [],
    version: 1,
    createdAt: "2026-09-25T00:00:00Z",
    updatedAt: "2026-09-25T00:00:00Z",
    embeddedAt: null,
    links: [],
    backlinks: [],
  };
}

test("complete local analysis survives unrelated edits while corpus searches require the exact snapshot", () => {
  const first = buildSnapshot([page("a"), page("source")]);
  const changed = buildSnapshot([
    page("a"),
    { ...page("source"), version: 2, markdown: "Correzione." },
  ]);
  const local = { status: "complete" as const };
  const corpus = { ...local, corpusSnapshotId: first.id };
  assert.equal(canReuseAnalysis(first.id, corpus), true);
  assert.equal(canReuseAnalysis(changed.id, local), true);
  assert.equal(canReuseAnalysis(changed.id, corpus), false);
  assert.equal(
    canReuseAnalysis(
      buildSnapshot([...first.pages, page("unlinked")]).id,
      corpus,
    ),
    false,
  );
  assert.equal(canReuseAnalysis(first.id, { status: "incomplete" }), false);
});

test("terminal decisions retain all expanded evidence dependencies", () => {
  const a = page("a");
  const source = page("source");
  const unrelated = page("unrelated");
  const first = buildSnapshot([a, source, unrelated]);
  const decision: DecisionRecord = {
    operationId: "local-plan",
    status: "uncertain",
    evidenceVersions: [
      { pageId: a.id, version: a.version },
      { pageId: source.id, version: source.version },
    ],
  };
  assert.equal(canReuseDecision(first, decision), true);
  assert.equal(
    canReuseDecision(
      buildSnapshot([a, source, { ...unrelated, version: 2 }]),
      decision,
    ),
    true,
  );
  assert.equal(
    canReuseDecision(
      buildSnapshot([a, { ...source, version: 2 }, unrelated]),
      decision,
    ),
    false,
  );
  assert.equal(
    canReuseDecision(buildSnapshot([a, unrelated]), decision),
    false,
  );
  assert.equal(
    canReuseDecision(first, { ...decision, status: "error" }),
    false,
  );
  assert.equal(
    canReuseDecision(first, { ...decision, reason: "capacity" }),
    true,
  );
});
