import assert from "node:assert/strict";
import test from "node:test";
import type { BrainPage } from "../lib/brain/types";
import {
  draftChanges,
  materializeDraft,
} from "../lib/maintenance/consolidator/editor";
import {
  planOperations,
  selectIndependentPlans,
} from "../lib/maintenance/consolidator/planner";
import {
  buildSnapshot,
  createAnalysisTasks,
} from "../lib/maintenance/consolidator/snapshot";
import type {
  AnalysisResult,
  Finding,
  Snapshot,
} from "../lib/maintenance/consolidator/types";

function page(id: string, markdown: string): BrainPage {
  return {
    id,
    slug: `note/${id}`,
    title: id,
    type: "note",
    markdown,
    summary: "",
    aliases: [],
    tags: [],
    version: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    embeddedAt: null,
    links: [],
    backlinks: [],
  };
}

function result(...findings: Finding[]): AnalysisResult {
  return { taskId: "fixture", findings, judgments: [], status: "complete" };
}

function finding(
  snapshot: Snapshot,
  overrides: Partial<Finding> = {},
): Finding {
  return {
    id: "finding",
    kind: "deduplicate",
    status: "supported",
    pageIds: snapshot.pages.map((entry) => entry.id),
    unitIds: snapshot.units.map((unit) => unit.id),
    evidenceUnitIds: snapshot.units.map((unit) => unit.id),
    goal: "Preserve the documented information once.",
    ...overrides,
  };
}

test("a directed link writes only its source and retains both pages as versioned evidence", async () => {
  const snapshot = buildSnapshot([
    page("project", "Project Aurora depends on the Archive service."),
    page("archive", "Archive supplies persistent storage to Project Aurora."),
  ]);
  const link = {
    sourceId: "project",
    targetId: "archive",
    type: "depends_on" as const,
  };
  const [plan] = planOperations(snapshot, [
    result(finding(snapshot, { kind: "add_link", link })),
  ]);
  assert.ok(plan);
  assert.deepEqual(plan.targetPageIds, ["project"]);
  assert.ok(
    plan.targetUnitIds.every(
      (id) =>
        snapshot.units.find((unit) => unit.id === id)?.pageId === "project",
    ),
  );
  assert.deepEqual(
    new Set(plan.evidenceUnitIds),
    new Set(snapshot.units.map((unit) => unit.id)),
  );
  assert.deepEqual(
    new Set(plan.readSet.map((ref) => ref.pageId)),
    new Set(["project", "archive"]),
  );
  // add_link uses deterministic drafting and must not require a provider call.
  const draft = await draftChanges(snapshot, plan);
  const changeSet = materializeDraft(snapshot, plan, draft);
  assert.equal(changeSet.changes.length, 1);
  assert.equal(changeSet.changes[0].before.id, "project");
  assert.equal(
    changeSet.changes[0].after.markdown,
    changeSet.changes[0].before.markdown,
  );
  assert.deepEqual(
    changeSet.changes[0].after.links.map(({ sourceId, targetId, type }) => ({
      sourceId,
      targetId,
      type,
    })),
    [link],
  );
});

test("link plan identity survives JSONB ordering of the snapshot and cached finding", () => {
  const snapshot = buildSnapshot([page("a", "Cita B."), page("b", "Fonte B.")]);
  const diagnosis = result(
    finding(snapshot, {
      kind: "add_link",
      link: { sourceId: "a", targetId: "b", type: "references" },
    }),
  );
  const roundtrip = JSON.parse(
    JSON.stringify({ snapshot, diagnosis }),
    (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value,
  ) as { snapshot: Snapshot; diagnosis: AnalysisResult };
  assert.equal(
    planOperations(snapshot, [diagnosis])[0].id,
    planOperations(roundtrip.snapshot, [roundtrip.diagnosis])[0].id,
  );
});

test("unrelated edits preserve local plans but invalidate plans that searched the corpus", () => {
  const first = buildSnapshot([
    page("a", "The documented launch date is 3 March."),
    page("b", "The launch date is 3 March."),
    page("source", "The original dated source establishes the launch period."),
  ]);
  const second = buildSnapshot(
    first.pages.map((entry) =>
      entry.id === "source"
        ? {
            ...entry,
            version: 2,
            markdown:
              "The dated source now contains an explicit correction to 4 March.",
          }
        : entry,
    ),
  );
  const pair = (snapshot: Snapshot) =>
    createAnalysisTasks(snapshot).find(
      (task) => task.kind === "pair" && task.pageIds.join(",") === "a,b",
    );
  assert.equal(pair(first)?.id, pair(second)?.id);
  assert.deepEqual(
    pair(first)?.unitIds,
    pair(second)?.unitIds,
    "the pair itself is unchanged; only its possible expanded source changed",
  );
  const units = first.units.filter((unit) => unit.pageId !== "source");
  const diagnosis = finding(first, {
    kind: "centralize",
    pageIds: ["a", "b"],
    unitIds: units.map((unit) => unit.id),
    evidenceUnitIds: units.map((unit) => unit.id),
    canonicalPageId: "a",
    retainedUnitId: units[0].id,
  });
  const [before] = planOperations(first, [result(diagnosis)]);
  const [after] = planOperations(second, [result(diagnosis)]);
  assert.ok(before && after);
  assert.deepEqual(before.readSet, after.readSet);
  assert.equal(before.id, after.id);
  const [corpusBefore] = planOperations(first, [
    { ...result(diagnosis), corpusSnapshotId: first.id },
  ]);
  const [corpusAfter] = planOperations(second, [
    { ...result(diagnosis), corpusSnapshotId: second.id },
  ]);
  assert.notEqual(corpusBefore.id, corpusAfter.id);
  const replay = buildSnapshot(
    [...first.pages].reverse(),
    "2026-09-25T23:00:00.000Z",
  );
  assert.equal(replay.id, first.id);
  assert.equal(planOperations(replay, [result(diagnosis)])[0].id, before.id);
});

test("a plan changes identity when any page in its actual read set changes", () => {
  const first = buildSnapshot([
    page("a", "Duplicato.\n\nDuplicato."),
    page("source", "Fonte del fatto."),
  ]);
  const second = buildSnapshot(
    first.pages.map((entry) =>
      entry.id === "source"
        ? { ...entry, version: 2, markdown: "Fonte del fatto corretta." }
        : entry,
    ),
  );
  const makePlan = (snapshot: Snapshot) =>
    planOperations(snapshot, [
      result(
        finding(snapshot, {
          pageIds: ["a"],
          unitIds: snapshot.units
            .filter((unit) => unit.pageId === "a")
            .map((unit) => unit.id),
        }),
      ),
    ])[0];
  const before = makePlan(first);
  const after = makePlan(second);
  assert.deepEqual(before.targetUnitIds, after.targetUnitIds);
  assert.notEqual(before.id, after.id);
});

test("correction direction preserves original A/B order rather than sorting unit IDs", () => {
  const snapshot = buildSnapshot([
    page("a", "Transcription reports 450 participants."),
    page("z", "The original source reports 4,500 participants."),
  ]);
  const a = snapshot.units.find((unit) => unit.pageId === "z");
  const b = snapshot.units.find((unit) => unit.pageId === "a");
  assert.ok(a && b);
  const base = finding(snapshot, {
    kind: "reconcile",
    unitIds: [a.id, b.id],
    resolution: "a",
  });
  const [keepA] = planOperations(snapshot, [result(base)]);
  const [keepB] = planOperations(snapshot, [
    result({ ...base, resolution: "b" }),
  ]);
  assert.deepEqual(keepA.targetUnitIds, [a.id, b.id]);
  assert.deepEqual(keepA.correctionUnitIds, [b.id]);
  assert.deepEqual(keepB.targetUnitIds, [a.id, b.id]);
  assert.deepEqual(keepB.correctionUnitIds, [a.id]);
  assert.notEqual(keepA.id, keepB.id);
});

test("unrelated writes can share read-only evidence while edits to that evidence are deferred", () => {
  const snapshot = buildSnapshot([
    page("a", "First fact."),
    page("b", "Second fact."),
    page("source", "Shared evidence."),
  ]);
  const unit = (id: string) => {
    const found = snapshot.units.find((entry) => entry.pageId === id);
    assert.ok(found);
    return found;
  };
  const make = (id: string, reads: string[]) =>
    finding(snapshot, {
      id,
      kind: "remove_maintenance_residue",
      pageIds: [id],
      unitIds: [unit(id).id],
      evidenceUnitIds: [id, ...reads].map((pageId) => unit(pageId).id),
    });
  const plans = planOperations(snapshot, [
    result(make("a", ["source"]), make("b", ["source"]), make("source", [])),
  ]);
  const forPage = (id: string) => {
    const plan = plans.find((entry) => entry.targetPageIds.includes(id));
    assert.ok(plan);
    return plan;
  };
  const selected = selectIndependentPlans([
    forPage("a"),
    forPage("b"),
    forPage("source"),
  ]);
  assert.deepEqual(
    selected.selected.map((plan) => plan.targetPageIds[0]),
    ["a", "b"],
  );
  assert.deepEqual(
    selected.deferred.map((plan) => plan.targetPageIds[0]),
    ["source"],
  );
});

test("overlapping deduplication pairs cannot authorize a transitive deletion of their retained facts", () => {
  const snapshot = buildSnapshot([
    page(
      "a",
      "Access is available in Italy.\n\nAccess is available in Italy.\n\nAccess is available in Italy. Enterprise access also requires SSO.",
    ),
  ]);
  const [a, b, c] = snapshot.units;
  assert.ok(a && b && c);
  const first = finding(snapshot, {
    id: "a-b",
    unitIds: [a.id, b.id],
    evidenceUnitIds: [a.id, b.id],
    retainedUnitId: a.id,
  });
  const second = finding(snapshot, {
    id: "b-c",
    unitIds: [b.id, c.id],
    evidenceUnitIds: [b.id, c.id],
    retainedUnitId: c.id,
  });
  const plans = planOperations(snapshot, [result(first, second)]);
  assert.equal(
    plans.length,
    2,
    "pairwise evidence must not invent a third A/C operation",
  );
  assert.ok(plans.every((plan) => plan.targetUnitIds.length === 2));
  const ab = plans.find((plan) => plan.retainedUnitId === a.id);
  const bc = plans.find((plan) => plan.retainedUnitId === c.id);
  assert.ok(ab && bc);
  const independent = selectIndependentPlans([ab, bc]);
  assert.deepEqual(independent.selected, [ab]);
  assert.deepEqual(independent.deferred, [bc]);
  const draft = {
    noChange: false,
    links: [],
    patches: [{ pageId: "a", unitId: b.id, before: b.text, after: "" }],
  };
  const materialized = materializeDraft(snapshot, ab, draft);
  const after = materialized.changes[0].after;
  assert.ok(after.markdown.includes(a.text));
  assert.ok(after.markdown.includes("Enterprise access also requires SSO."));
  assert.throws(
    () =>
      materializeDraft(snapshot, bc, {
        ...draft,
        patches: [{ pageId: "a", unitId: c.id, before: c.text, after: "" }],
      }),
    /retained unit cannot be deleted/,
  );
  const current = buildSnapshot([{ ...after, version: after.version + 1 }]);
  assert.equal(
    planOperations(current, [result(second)]).length,
    0,
    "a deferred proposal must be reanalysed after its original units changed",
  );
});

test("incoming backlinks do not invalidate a local plan on an unchanged target", () => {
  const before = buildSnapshot([
    page("a", "Fonte."),
    page("b", "Fatto B.\n\nFatto B."),
  ]);
  const unitIds = before.units
    .filter((unit) => unit.pageId === "b")
    .map((unit) => unit.id);
  const analysis = result(
    finding(before, {
      pageIds: ["b"],
      unitIds,
      evidenceUnitIds: unitIds,
      retainedUnitId: unitIds[0],
    }),
  );
  const [original] = planOperations(before, [analysis]);
  assert.ok(original);
  const link = {
    id: "ab",
    sourceId: "a",
    targetId: "b",
    type: "references" as const,
    label: "B",
  };
  const after = buildSnapshot(
    before.pages.map((entry) =>
      entry.id === "a"
        ? { ...entry, version: 2, links: [link] }
        : { ...entry, backlinks: [link] },
    ),
  );
  const [current] = planOperations(after, [analysis]);
  assert.equal(current.id, original.id);
  assert.deepEqual(current.readSet, original.readSet);
  const corpusAnalysis = { ...analysis, corpusSnapshotId: before.id };
  assert.notEqual(
    planOperations(before, [corpusAnalysis])[0].id,
    planOperations(after, [{ ...analysis, corpusSnapshotId: after.id }])[0].id,
    "a plan that searched the corpus still follows the changed source edge",
  );
});
