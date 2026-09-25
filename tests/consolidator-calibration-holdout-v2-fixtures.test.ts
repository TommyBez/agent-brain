import assert from "node:assert/strict";
import test from "node:test";
import { materializeDraft } from "../lib/maintenance/consolidator/editor";
import { fingerprint } from "../lib/maintenance/consolidator/snapshot";
import { calibrationCases } from "./helpers/consolidation-calibration-cases";
import { calibrationHoldoutV2Cases } from "./helpers/consolidation-calibration-holdout-v2";

test("second verifier holdout has seven separate prospective scenario pairs", () => {
  const cases = calibrationHoldoutV2Cases();
  assert.equal(cases.length, 14);
  assert.equal(new Set(cases.map((entry) => entry.id)).size, 14);
  assert.equal(new Set(cases.map((entry) => entry.scenarioId)).size, 7);
  assert.deepEqual(calibrationHoldoutV2Cases(), cases);
  assert.equal(fingerprint(calibrationHoldoutV2Cases()), fingerprint(cases));
  assert.ok(cases.every((entry) => entry.split === "holdout"));
  assert.equal(cases.filter((entry) => entry.expectedAccept).length, 7);
  assert.equal(cases.filter((entry) => !entry.expectedAccept).length, 7);
  const old = calibrationCases();
  const oldIds = new Set(old.map((entry) => entry.id));
  const oldPages = new Set(
    old.flatMap((entry) => entry.snapshot.pages.map((page) => page.id)),
  );
  const oldTexts = new Set(
    old.flatMap((entry) => entry.snapshot.pages.map((page) => page.markdown)),
  );
  for (const entry of cases) {
    assert.equal(oldIds.has(entry.id), false);
    assert.equal(entry.snapshot.createdAt, "2026-09-25T00:00:00.000Z");
    for (const page of entry.snapshot.pages) {
      assert.equal(oldPages.has(page.id), false);
      assert.equal(oldTexts.has(page.markdown), false);
    }
  }
  for (const scenario of new Set(cases.map((entry) => entry.scenarioId))) {
    const [safe, unsafe] = cases.filter(
      (entry) => entry.scenarioId === scenario,
    );
    assert.equal(safe.expectedAccept, true);
    assert.equal(unsafe.expectedAccept, false);
    assert.deepEqual(safe.snapshot, unsafe.snapshot);
    assert.notDeepEqual(safe.draft, unsafe.draft);
    assert.ok(unsafe.expectedViolation);
  }
});

test("every second-holdout draft materializes exactly without a structural shortcut", () => {
  for (const entry of calibrationHoldoutV2Cases()) {
    assert.equal(entry.structural, undefined, entry.id);
    const result = materializeDraft(entry.snapshot, entry.plan, entry.draft);
    assert.ok(result.changes.length, entry.id);
    for (const page of entry.snapshot.pages) {
      const units = entry.snapshot.units.filter(
        (unit) => unit.pageId === page.id,
      );
      assert.equal(
        units.map((unit) => unit.text).join(""),
        page.markdown,
        entry.id,
      );
      let cursor = 0;
      for (const unit of units) {
        assert.equal(unit.start, cursor, entry.id);
        assert.equal(
          unit.text,
          page.markdown.slice(unit.start, unit.end),
          entry.id,
        );
        cursor = unit.end;
      }
      assert.equal(cursor, page.markdown.length, entry.id);
      assert.ok(
        entry.plan.readSet.some(
          (ref) => ref.pageId === page.id && ref.version === page.version,
        ),
        entry.id,
      );
    }
    for (const patch of entry.draft.patches) {
      const unit = entry.snapshot.units.find(
        (candidate) => candidate.id === patch.unitId,
      );
      assert.ok(unit, entry.id);
      assert.equal(patch.before, unit.text, entry.id);
      assert.ok(entry.plan.targetUnitIds.includes(patch.unitId), entry.id);
    }
    for (const patch of entry.draft.summaryPatches ?? []) {
      assert.ok(
        entry.draft.patches.some((body) => body.pageId === patch.pageId),
        entry.id,
      );
      assert.equal(
        entry.snapshot.pages.find((page) => page.id === patch.pageId)?.summary,
        patch.before,
        entry.id,
      );
      assert.equal(
        result.changes.find(({ after }) => after.id === patch.pageId)?.after
          .summary,
        patch.after,
        entry.id,
      );
    }
  }
});

test("second holdout covers undated knowledge, source association and genuinely documented temporal change", () => {
  const cases = calibrationHoldoutV2Cases();
  assert.equal(
    cases.filter((entry) => entry.plan.kind === "centralize").length,
    4,
  );
  const failures = new Set(
    cases
      .filter((entry) => !entry.expectedAccept)
      .map((entry) => entry.expectedViolation),
  );
  assert.deepEqual(
    [...failures].sort(),
    [
      "conditions",
      "provenance",
      "negations",
      "summary_conditions",
      "no_human_work",
      "time",
      "link_direction",
    ].sort(),
  );
  const residue = cases.find(
    (entry) => entry.id === "holdout-v2-marionette-residue-safe",
  );
  assert.ok(residue);
  assert.equal(/\b20\d{2}\b/.test(residue.snapshot.pages[0].markdown), false);
  const afterResidue = materializeDraft(
    residue.snapshot,
    residue.plan,
    residue.draft,
  ).changes[0].after;
  assert.match(afterResidue.markdown, /panno morbido asciutto/);
  assert.doesNotMatch(afterResidue.markdown, /consolidatore/);
  const summaryCase = cases.find(
    (entry) => entry.id === "holdout-v2-seed-bank-summary-safe",
  );
  assert.ok(summaryCase);
  const originalPage = summaryCase.snapshot.pages.find(
    (page) => page.id === "h2-seed-bank",
  );
  assert.ok(originalPage);
  assert.doesNotMatch(originalPage.markdown, /tessera attiva/);
  assert.match(originalPage.summary, /tessera attiva/);
  assert.match(
    summaryCase.draft.summaryPatches?.[0].after ?? "",
    /tessera attiva/,
  );
  const temporal = cases.find(
    (entry) => entry.id === "holdout-v2-game-loan-transition-safe",
  );
  assert.ok(temporal);
  assert.match(
    temporal.snapshot.pages.find((page) => page.id === "h2-game-circular")
      ?.markdown ?? "",
    /Dal 1 settembre 2026 il massimo diventa 5/,
  );
  assert.match(temporal.draft.patches[0].after, /Dal 1 settembre 2026/);
});
