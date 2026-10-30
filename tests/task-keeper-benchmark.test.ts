import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  benchmarkMetrics,
  benchmarkPage,
  extractionBenchmarkSchema,
  type PredictedItem,
  scoreCase,
} from "../lib/maintenance/task-keeper/benchmark";
import { buildKeeperSnapshot } from "../lib/maintenance/task-keeper/snapshot";

const dataset = extractionBenchmarkSchema.parse(
  JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../docs/benchmarks/2026-10-21-task-extraction/dataset.json",
      ),
      "utf8",
    ),
  ),
);

test("the extraction benchmark covers every required category with ≥30 cases", () => {
  assert.ok(dataset.cases.length >= 30);
  for (const category of [
    "impegno_esplicito",
    "ipotesi",
    "proposta",
    "voce_gia_fatta",
    "scadenza_relativa",
    "assegnatario_gruppo",
    "prossimi_passi_agente",
  ])
    assert.ok(
      dataset.cases.some((item) => item.category === category),
      category,
    );
  const negatives = dataset.cases.filter((item) => !item.expected.length);
  assert.ok(negatives.length >= 10, "enough cases where nothing is a task");
  for (const item of dataset.cases) {
    const snapshot = buildKeeperSnapshot(benchmarkPage(item), []);
    assert.ok(snapshot.units.length > 0, item.id);
    for (const expected of item.expected)
      assert.ok(
        snapshot.units.some((unit) => unit.text.includes(expected.passage)),
        `${item.id}: one passage holds "${expected.passage}"`,
      );
  }
});

test("scoring matches cited passages one to one and counts invented work", () => {
  const mixed = dataset.cases.find((item) => item.id === "C28");
  const negative = dataset.cases.find((item) => item.id === "C07");
  assert.ok(mixed && negative);
  const predicted = (
    excerpt: string,
    overrides: Partial<PredictedItem> = {},
  ): PredictedItem => ({
    title: excerpt,
    excerpt,
    actorNames: [],
    dueKind: "unset",
    dueDate: null,
    dueText: null,
    ...overrides,
  });
  const perfect = scoreCase(mixed, [
    predicted(
      "- Mario Rossi: preparare il report clinico entro il 30/10/2026.",
      {
        actorNames: ["Mario Rossi"],
        dueKind: "date",
        dueDate: "2026-10-30",
      },
    ),
    predicted(
      "- Giulia Bianchi contatterà il fornitore dei kit e riferirà alla prossima riunione.",
      { actorNames: ["Giulia Bianchi"], dueKind: "event" },
    ),
    predicted("- Tutti: rivedere la bozza del protocollo.", {
      actorNames: ["Tutti"],
    }),
  ]);
  assert.equal(perfect.correct, true);
  assert.equal(perfect.actorCorrect, 3);
  assert.equal(perfect.dueKindCorrect, 3);
  assert.equal(perfect.dueDateCorrect, 1);
  const invented = scoreCase(negative, [
    predicted("- Potremmo valutare un nuovo fornitore per i kit diagnostici.", {
      actorNames: ["Ufficio acquisti"],
      dueDate: "2026-11-01",
      dueKind: "date",
    }),
  ]);
  assert.equal(invented.correct, false);
  assert.equal(invented.falsePositives, 1);
  assert.equal(invented.inventedActors, 1);
  assert.equal(invented.wrongDates, 1);
  const metrics = benchmarkMetrics([perfect, invented]);
  assert.equal(metrics.items.precision, 0.75);
  assert.equal(metrics.items.recall, 1);
  assert.equal(metrics.inventedTasks, 1);
  assert.equal(metrics.caseAccuracy, 0.5);
  assert.deepEqual(metrics.categories.proposta, { cases: 1, accuracy: 0 });
});
