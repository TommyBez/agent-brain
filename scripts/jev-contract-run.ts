import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvConfig } from "@next/env";
import { fingerprint } from "../lib/canonical-json";
import { ModelAdapter } from "./apo/models";
import { gatewayOptimizer, optimizerPayload } from "./apo/optimizer";
import { report } from "./apo/report";
import { Experiment } from "./apo/runner";
import { ExperimentStore, engineHash, type Manifest } from "./apo/store";

// Contract review only: no test scores or test examples enter optimizer feedback.
const feedback = {
  destination: [
    "A prior candidate incorrectly treated all temporary event pages as unsuitable canonical homes. An event page can be the canonical home of facts about that event, even when another page is a stable subject page. Assess suitability relative to the shared knowledge, not an absolute ranking of page categories. None means neither supplied target is supported; equivalent means both are equally suitable. Preserve these exact definitions.",
  ],
  relation: [
    "A prior candidate contradicted the none criterion by saying none applies only when no relationship is evidenced and by assuming the typed link is absent. Existing matching typed links are valid inputs and require none even when the relationship is clearly evidenced. Check the actual source.links; never assume absence. None means no supported MISSING relationship, not no evidenced relationship. Preserve every fixed relation definition and direction.",
  ],
  duplicate: [
    "Different primary page subjects do not rule out duplication of a claim about a shared third entity. Compare the entity and scope of the repeated factual claim, not just page titles or primary page subjects. Explicitly distinct homonyms must not be merged. Do not require the entire pages to describe the same primary entity.",
  ],
  residue: [
    "A source citation is not an agent-added human follow-up. Useful citations and source-to-fact associations remain knowledge even when added by an agent. Do not remove them merely because they are not standalone subject facts. Distinguish original human testimony about completed subject work from an agent's own page-maintenance diary; first-person wording alone does not establish agent authorship. Detect removable fragments in mixed content without authorizing removal of surrounding knowledge.",
  ],
} as const;

async function main() {
  const path = process.argv[2];
  assert(path, "Specificare il nuovo esperimento destination/relation");
  const store = new ExperimentStore(path);
  const manifest = await store.read<Manifest>("manifest.json");
  assert.equal(fingerprint(manifest), await store.read("manifest-hash.json"));
  assert.deepEqual(manifest.config.tasks, [
    "destination",
    "relation",
    "duplicate",
    "residue",
  ]);
  assert.equal(
    manifest.engineHash,
    await engineHash(resolve(import.meta.dirname, "..")),
  );
  const protocol = {
    feedback,
    wrapperHash: fingerprint(await readFile(import.meta.filename, "utf8")),
    policy:
      "Only generic semantic contract critique and this experiment's own training errors. No prior or current held-out outcomes. Baseline, criteria, thresholds, validation selection and frozen test protocol remain unchanged.",
  };
  const saved = await store.maybe("contract-protocol.json");
  if (saved) assert.equal(fingerprint(saved), fingerprint(protocol));
  else {
    assert(!(await store.maybe("frozen.json")));
    await store.write("contract-protocol.json", protocol, true);
  }
  loadEnvConfig(resolve(import.meta.dirname, ".."));
  const unlock = await store.lock();
  try {
    const adapter = new ModelAdapter(store, manifest);
    const baseOptimizer = gatewayOptimizer(adapter);
    const experiment = new Experiment(
      store,
      manifest,
      adapter.decision,
      async (input, id) => {
        assert(
          input.task === "destination" ||
            input.task === "relation" ||
            input.task === "duplicate" ||
            input.task === "residue",
        );
        const enriched = {
          ...input,
          previous: [
            {
              changes: [
                "Semantic review of the immutable application contract",
              ],
              reason: [...feedback[input.task]],
            },
            ...input.previous,
          ],
        };
        const payload = optimizerPayload(enriched);
        const file = `optimizer-inputs/${fingerprint(id)}.json`;
        const prior = await store.maybe(file);
        if (prior) assert.equal(fingerprint(prior), fingerprint(payload));
        else await store.write(file, payload, true);
        return baseOptimizer(enriched, id);
      },
      (message) => console.log(`${new Date().toISOString()} ${message}`),
    );
    try {
      await experiment.search();
      adapter.final = true;
      await experiment.final();
    } finally {
      const summary = await report(store, manifest);
      console.log(
        JSON.stringify({ status: summary.status, usage: summary.usage }),
      );
    }
  } finally {
    await unlock();
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Contract experiment failed",
  );
  process.exitCode = 1;
});
