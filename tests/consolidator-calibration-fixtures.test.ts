import assert from "node:assert/strict";
import test from "node:test";
import { materializeDraft } from "../lib/maintenance/consolidator/editor";
import { fingerprint } from "../lib/maintenance/consolidator/snapshot";
import { calibrationCases } from "./helpers/consolidation-calibration-cases";

const operations = [
  "deduplicate",
  "centralize",
  "add_link",
  "reconcile",
  "remove_maintenance_residue",
].sort();

test("frozen synthetic calibration corpus has separate complete scenario pairs", () => {
  const cases = calibrationCases();
  assert.equal(cases.length, 44);
  assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);
  assert.deepEqual(calibrationCases(), cases);
  assert.equal(fingerprint(calibrationCases()), fingerprint(cases));

  for (const [split, count, scenarios] of [
    ["calibration", 26, 13],
    ["holdout", 18, 9],
  ] as const) {
    const subset = cases.filter((entry) => entry.split === split);
    assert.equal(subset.length, count);
    assert.equal(
      new Set(subset.map((entry) => entry.scenarioId)).size,
      scenarios,
    );
    assert.deepEqual(
      [...new Set(subset.map((entry) => entry.plan.kind))].sort(),
      operations,
    );
    assert.equal(
      subset.filter((entry) => entry.expectedAccept).length,
      count / 2,
    );
    assert.equal(
      subset.filter((entry) => !entry.expectedAccept).length,
      count / 2,
    );
    for (const scenario of new Set(subset.map((entry) => entry.scenarioId))) {
      const pair = subset.filter((entry) => entry.scenarioId === scenario);
      assert.equal(pair.length, 2);
      assert.equal(pair[0].expectedAccept, true);
      assert.equal(pair[1].expectedAccept, false);
      assert.deepEqual(pair[0].snapshot, pair[1].snapshot);
      assert.notDeepEqual(pair[0].draft, pair[1].draft);
      assert.ok(pair[1].expectedViolation);
    }
  }
  const developmentPageIds = new Set(
    cases
      .filter((entry) => entry.split === "calibration")
      .flatMap((entry) => entry.snapshot.pages.map((page) => page.id)),
  );
  const developmentScenarios = new Set(
    cases
      .filter((entry) => entry.split === "calibration")
      .map((entry) => entry.scenarioId),
  );
  for (const entry of cases.filter((entry) => entry.split === "holdout")) {
    assert.equal(developmentScenarios.has(entry.scenarioId), false);
    for (const page of entry.snapshot.pages)
      assert.equal(developmentPageIds.has(page.id), false);
  }
});

test("every oracle draft materializes with exact scope and complete source coverage", () => {
  for (const entry of calibrationCases()) {
    assert.equal(entry.structural, undefined, entry.id);
    const changes = materializeDraft(entry.snapshot, entry.plan, entry.draft);
    assert.ok(changes.changes.length > 0, entry.id);
    assert.equal(entry.draft.noChange, false, entry.id);
    for (const page of entry.snapshot.pages) {
      const units = entry.snapshot.units.filter(
        (unit) => unit.pageId === page.id,
      );
      assert.equal(
        units.map((unit) => unit.text).join(""),
        page.markdown,
        entry.id,
      );
      let end = 0;
      for (const unit of units) {
        assert.equal(unit.start, end, entry.id);
        assert.equal(
          page.markdown.slice(unit.start, unit.end),
          unit.text,
          entry.id,
        );
        end = unit.end;
      }
      assert.equal(end, page.markdown.length, entry.id);
      assert.ok(
        entry.plan.readSet.some(
          (ref) => ref.pageId === page.id && ref.version === page.version,
        ),
        entry.id,
      );
    }
    for (const patch of entry.draft.patches) {
      const source = entry.snapshot.units.find(
        (unit) => unit.id === patch.unitId,
      );
      assert.ok(source, entry.id);
      assert.equal(patch.before, source.text, entry.id);
      assert.ok(entry.plan.targetUnitIds.includes(patch.unitId), entry.id);
      assert.ok(entry.plan.targetPageIds.includes(patch.pageId), entry.id);
    }
    for (const { before, after } of changes.changes) {
      assert.equal(before.id, after.id, entry.id);
      assert.equal(before.version, after.version, entry.id);
      const summaryPatch = entry.draft.summaryPatches?.find(
        (patch) => patch.pageId === before.id,
      );
      assert.equal(
        summaryPatch?.before ?? before.summary,
        before.summary,
        entry.id,
      );
      assert.equal(
        after.summary,
        summaryPatch?.after ?? before.summary,
        entry.id,
      );
      if (summaryPatch)
        assert.ok(
          entry.draft.patches.some((patch) => patch.pageId === before.id),
          entry.id,
        );
    }
  }
});

test("dangerous semantic cases cover all required failure families without structural shortcuts", () => {
  const negative = calibrationCases().filter((entry) => !entry.expectedAccept);
  const families = new Set(negative.map((entry) => entry.expectedViolation));
  for (const family of [
    "exceptions",
    "provenance",
    "preservation",
    "keeper",
    "link_target_identity",
    "link_direction",
    "quantities",
    "time",
    "certainty",
    "no_human_work",
    "objective",
    "negations",
    "no_diary",
    "conditions",
    "scope",
    "summary_coherence",
    "summary_support",
  ])
    assert.ok(families.has(family), family);
  assert.ok(negative.some((entry) => entry.category === "useful-no-op-proof"));
  assert.ok(
    negative.some((entry) => entry.category === "measurement-scope-loss"),
  );
  assert.ok(
    negative.some((entry) => entry.category === "complementary-detail-loss"),
  );
});
