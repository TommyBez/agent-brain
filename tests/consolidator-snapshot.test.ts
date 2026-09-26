import assert from "node:assert/strict";
import test from "node:test";
import type { BrainPage } from "../lib/brain/types";
import {
  buildSnapshot,
  createAnalysisTasks,
  fingerprint,
  segmentPage,
} from "../lib/maintenance/consolidator/snapshot";
import { POLICY } from "../lib/maintenance/consolidator/types";

function page(id: string, markdown: string): BrainPage {
  return {
    id,
    slug: id,
    title: id,
    type: "note",
    summary: "",
    aliases: [],
    tags: [],
    version: 1,
    createdAt: "2026-09-25T00:00:00Z",
    updatedAt: "2026-09-25T00:00:00Z",
    embeddedAt: null,
    markdown,
    links: [],
    backlinks: [],
  };
}

test("segmentation preserves every source character, Unicode, fences and table headers", () => {
  const markdown = `### Premessa\n\n${"Testo 🧠 con condizioni. ".repeat(240)}\n\n\`\`\`ts\n${"const esempio = 'test';\n".repeat(220)}\`\`\`\n\n| Data | Decisione |\n| --- | --- |\n${"| 2026-09-25 | Mantieni la fonte |\n".repeat(180)}`;
  const units = segmentPage(page("a", markdown));
  assert.equal(units.map((unit) => unit.text).join(""), markdown);
  for (let index = 0; index < units.length; index++) {
    const unit = units[index];
    assert.equal(unit.start, index ? units[index - 1].end : 0);
    assert.equal(unit.text, markdown.slice(unit.start, unit.end));
    assert.ok(unit.text.length <= POLICY.maxUnitCharacters);
    assert.ok(!/^[\uDC00-\uDFFF]/.test(unit.text));
    assert.ok(unit.headings.every((heading) => typeof heading === "string"));
  }
  assert.ok(
    units.some(
      (unit) => unit.text.startsWith("const") && unit.context.includes("```ts"),
    ),
  );
  assert.ok(
    units.some(
      (unit) =>
        unit.text.startsWith("| 2026") &&
        unit.context.includes("| Data | Decisione |"),
    ),
  );
});

test("every unit pair is covered, including distant windows within long pages", () => {
  const snapshot = buildSnapshot([
    page(
      "a",
      Array.from(
        { length: 18 },
        (_, i) => `${i}: ${"a".repeat(2200)}\n\n`,
      ).join(""),
    ),
    page("b", "Testo distinto."),
    page("c", "Altra pagina."),
  ]);
  const tasks = createAnalysisTasks(snapshot);
  for (let i = 0; i < snapshot.units.length; i++) {
    assert.ok(
      tasks.some((task) => task.unitIds.includes(snapshot.units[i].id)),
    );
    for (let j = i + 1; j < snapshot.units.length; j++) {
      assert.ok(
        tasks.some(
          (task) =>
            task.unitIds.includes(snapshot.units[i].id) &&
            task.unitIds.includes(snapshot.units[j].id),
        ),
        `missing ${i},${j}`,
      );
    }
  }
  assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length);
  assert.ok(
    tasks.some((task) => task.kind === "pair" && task.pageIds.join() === "b,c"),
  );
});

test("skipped heading levels preserve scope without treating siblings as parents", () => {
  const units = segmentPage(
    page(
      "a",
      "### Primo\n\nUno.\n\n### Secondo\n\nDue.\n\n# Radice\n\n### Figlio\n\nTre.\n\n## Fratello\n\nQuattro.",
    ),
  );
  assert.deepEqual(units.find((unit) => unit.text.includes("Due."))?.headings, [
    "Secondo",
  ]);
  assert.deepEqual(units.find((unit) => unit.text.includes("Tre."))?.headings, [
    "Radice",
    "Figlio",
  ]);
  assert.deepEqual(
    units.find((unit) => unit.text.includes("Quattro."))?.headings,
    ["Radice", "Fratello"],
  );
});

test("task identities preserve unchanged page work while the corpus identity tracks other sources", () => {
  const a = page("a", "Primo.");
  const b = page("b", "Secondo.");
  const c = page("c", "Fonte originale.");
  const first = buildSnapshot([a, b, c], "2026-09-25");
  assert.equal(first.id, buildSnapshot([c, b, a], "2026-09-26").id);
  const second = buildSnapshot([
    a,
    b,
    { ...c, version: 2, markdown: "Fonte corretta." },
  ]);
  const pairId = (snapshot: typeof first) =>
    createAnalysisTasks(snapshot).find((task) => task.pageIds.join() === "a,b")
      ?.id;
  assert.notEqual(first.id, second.id);
  assert.equal(pairId(first), pairId(second));
  assert.equal(a.markdown, "Primo.");
});

test("task identities include complete involved-page evidence beyond selected unit text", () => {
  const first = buildSnapshot([page("a", "Primo."), page("b", "Secondo.")]);
  const second = buildSnapshot(
    first.pages.map((entry) =>
      entry.id === "a"
        ? { ...entry, summary: "Contesto aggiornato.", version: 2 }
        : entry,
    ),
  );
  const oldTasks = createAnalysisTasks(first);
  for (const current of createAnalysisTasks(second)) {
    const previous = oldTasks.find(
      (task) => task.pageIds.join() === current.pageIds.join(),
    );
    assert.ok(previous);
    if (current.pageIds.includes("a")) assert.notEqual(current.id, previous.id);
    else assert.equal(current.id, previous.id);
  }
});

test("embedding completion does not invalidate unchanged evidence and judgments", () => {
  const original = page("a", "Informazione invariata.");
  const first = buildSnapshot([original]);
  const indexed = buildSnapshot([
    { ...original, embeddedAt: "2026-09-25T23:00:00Z" },
  ]);
  assert.equal(indexed.id, first.id);
  assert.deepEqual(createAnalysisTasks(indexed), createAnalysisTasks(first));
  assert.notEqual(
    buildSnapshot([{ ...original, summary: "Riassunto diverso.", version: 2 }])
      .id,
    first.id,
  );
});

test("adding an inbound link preserves target tasks while invalidating its source and corpus", () => {
  const before = buildSnapshot([
    page("a", "Riferimento a B."),
    page("b", "Fatti di B."),
    page("c", "Altri fatti."),
  ]);
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
        : entry.id === "b"
          ? { ...entry, backlinks: [link] }
          : entry,
    ),
  );
  assert.notEqual(
    after.id,
    before.id,
    "corpus-dependent searches must see the new source edge",
  );
  const previousTasks = createAnalysisTasks(before);
  for (const task of createAnalysisTasks(after)) {
    const previous = previousTasks.find(
      (entry) => entry.pageIds.join() === task.pageIds.join(),
    );
    assert.ok(previous);
    if (task.pageIds.includes("a")) assert.notEqual(task.id, previous.id);
    else assert.equal(task.id, previous.id);
  }
});

test("persisted JSON object ordering preserves snapshot and task identities", () => {
  const a = page("a", "Riferimento a B.");
  a.links = [
    { id: "ab", sourceId: "a", targetId: "b", type: "references", label: "B" },
  ];
  const snapshot = buildSnapshot([a, page("b", "Fonte B.")]);
  const roundtrip = JSON.parse(JSON.stringify(snapshot), (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse())
      : value,
  ) as typeof snapshot;
  assert.equal(buildSnapshot(roundtrip.pages).id, snapshot.id);
  assert.deepEqual(
    createAnalysisTasks(roundtrip),
    createAnalysisTasks(snapshot),
  );
  assert.equal(
    fingerprint({ a: 1, b: { c: 2, d: 3 } }),
    fingerprint({ b: { d: 3, c: 2 }, a: 1 }),
  );
  assert.notEqual(fingerprint(["a", "b"]), fingerprint(["b", "a"]));
});
