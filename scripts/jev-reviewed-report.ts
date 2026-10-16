import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fingerprint } from "../lib/canonical-json";
import { metrics, pairedInterval, selectCandidate } from "./apo/metrics";
import type { FrozenSelection } from "./apo/runner";
import { ExperimentStore, type Manifest } from "./apo/store";
import type { Prediction } from "./apo/types";

/** Apply a source-quality exclusion declared before test access. Never changes selection or raw artifacts. */
async function main() {
  const runPath = process.argv[2];
  assert(runPath, "Specificare la directory dell'esperimento");
  const store = new ExperimentStore(runPath);
  const manifest = await store.read<Manifest>("manifest.json");
  assert.equal(fingerprint(manifest), await store.read("manifest-hash.json"));
  const frozen = await store.read<FrozenSelection>("frozen.json");
  const review = await store.read<{
    declaredAt: string;
    excludedGroups: string[];
    excludedExampleIds: string[];
    reason: string;
  }>("quality-review.json");
  assert(
    Date.parse(review.declaredAt) < Date.parse(frozen.frozenAt),
    "Quality exclusion must predate frozen test access",
  );
  const excluded = new Set(review.excludedGroups);
  const ids = new Set(
    manifest.dataset.filter((e) => excluded.has(e.group)).map((e) => e.id),
  );
  assert.deepEqual([...ids].sort(), [...review.excludedExampleIds].sort());
  assert(
    [...ids].every((id) => manifest.splits.test.includes(id)),
    "Training and validation must be unaffected",
  );
  const raw = await store.read<{
    status: string;
    tasks: Record<string, unknown>;
    [key: string]: unknown;
  }>("report.json");
  assert.equal(raw.status, "complete");
  const predictions = await Promise.all(
    (await readdir(store.path("predictions")))
      .filter((p) => p.endsWith(".json"))
      .map((p) => store.read<Prediction>(`predictions/${p}`)),
  );
  const tasks: Record<string, unknown> = {};
  const lines = [
    "# Risultati dopo la revisione della qualità delle fonti",
    "",
    `Esclusione dichiarata prima del test: ${review.reason}`,
    "",
    `Le ${ids.size} varianti della famiglia esclusa non influenzano training, validation o selezione. Il test utilizzabile contiene ${manifest.splits.test.length - ids.size} casi in tre famiglie indipendenti. Il report e gli esiti originali sono conservati integralmente.`,
    "",
    "| Task | Macro-F1 prima | Macro-F1 dopo | Variazione | IC 95% variazione | Esito |",
    "|---|---:|---:|---:|---|---|",
  ];
  for (const task of manifest.config.tasks) {
    const rows = predictions.filter(
      (p) => p.task === task && p.split === "test" && !excluded.has(p.group),
    );
    const beforeRows = rows.filter(
      (p) => p.promptHash === fingerprint(manifest.baseline[task]),
    );
    const afterRows = rows.filter(
      (p) => p.promptHash === fingerprint(frozen.prompts[task]),
    );
    const expectedCount =
      manifest.dataset.filter(
        (e) =>
          e.task === task &&
          manifest.splits.test.includes(e.id) &&
          !excluded.has(e.group),
      ).length * manifest.config.repeats;
    assert.equal(beforeRows.length, expectedCount);
    assert.equal(afterRows.length, expectedCount);
    const before = metrics(task, beforeRows),
      after = metrics(task, afterRows);
    const interval = pairedInterval(
      task,
      beforeRows,
      afterRows,
      manifest.config.seed,
    );
    const operational = selectCandidate(
      task,
      beforeRows,
      afterRows,
      manifest.config,
    );
    const paired = new Map(
      afterRows.map((p) => [`${p.exampleId}:${p.repeat}`, p]),
    );
    const corrected = [
      ...new Set(
        beforeRows
          .filter(
            (p) =>
              p.predicted !== p.expected &&
              paired.get(`${p.exampleId}:${p.repeat}`)?.predicted ===
                p.expected,
          )
          .map((p) => p.exampleId),
      ),
    ];
    const regressions = [
      ...new Set(
        beforeRows
          .filter(
            (p) =>
              p.predicted === p.expected &&
              paired.get(`${p.exampleId}:${p.repeat}`)?.predicted !==
                p.expected,
          )
          .map((p) => p.exampleId),
      ),
    ];
    const delta = after.macroF1 - before.macroF1;
    const recommendation =
      delta >= manifest.config.minImprovement &&
      interval.lower > 0 &&
      operational.accepted
        ? "candidate_for_review"
        : "retain_baseline";
    const result = {
      before,
      after,
      delta,
      interval,
      corrected,
      regressions,
      recommendation,
      operational,
    };
    tasks[task] = {
      ...(raw.tasks[task] as Record<string, unknown>),
      final: result,
    };
    const pct = (n: number) => (n * 100).toFixed(2);
    lines.push(
      `| ${task} | ${pct(before.macroF1)}% | ${pct(after.macroF1)}% | ${pct(delta)} pp | [${pct(interval.lower)}, ${pct(interval.upper)}] pp | ${recommendation} |`,
    );
  }
  lines.push(
    "",
    "Il test non modifica i prompt congelati. Questi risultati riguardano fonti fittizie, con etichette costruite e senza validazione umana. Tre famiglie sono poche: gli intervalli restano esplorativi. Il profilo richiede anche revisione semantica; nessun risultato misura l'accuratezza in produzione.",
    "",
  );
  await store.write("reviewed-report.json", {
    ...raw,
    qualityReview: review,
    effectiveSplits: {
      ...manifest.splits,
      test: manifest.splits.test.filter((id) => !ids.has(id)),
    },
    tasks,
  });
  await store.text("reviewed-report.md", lines.join("\n"));
  console.log(lines.join("\n"));
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Report failed");
    process.exitCode = 1;
  });
