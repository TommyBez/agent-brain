import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadEnvConfig } from "@next/env";
import { fingerprint } from "../lib/canonical-json";
import { JEV_MODEL } from "../lib/maintenance/consolidator/jev";
import {
  BASELINE_PROMPTS,
  CORE_PROMPT_TASKS,
  type PromptTask,
  validateProfile,
} from "../lib/maintenance/consolidator/prompts";
import {
  splitDataset,
  supervisionSummary,
  validateDataset,
  validateSplits,
} from "./apo/dataset";
import { generateDataset } from "./apo/fixtures";
import { BudgetStop, ModelAdapter, validateCatalog } from "./apo/models";
import { gatewayOptimizer, OPTIMIZER_SYSTEM } from "./apo/optimizer";
import { report } from "./apo/report";
import { Experiment, type FrozenSelection } from "./apo/runner";
import { ExperimentStore, engineHash, type Manifest } from "./apo/store";
import {
  llmSupervision,
  recordedSupervision,
  type SupervisionStrategy,
} from "./apo/supervision";
import { configSchema } from "./apo/types";

const root = resolve(import.meta.dirname, "..");
const read = async (path: string) =>
  JSON.parse(await readFile(resolve(path), "utf8"));
const write = async (path: string, value: unknown) =>
  writeFile(resolve(path), `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
async function main() {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      run: { type: "string" },
      dataset: { type: "string" },
      config: { type: "string" },
      catalog: { type: "string" },
      task: { type: "string" },
      prompt: { type: "string" },
      profile: { type: "string" },
      strategy: { type: "string" },
      smoke: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const required = (name: keyof typeof v) => {
    const value = v[name];
    assert(typeof value === "string" && value, `Missing --${name}`);
    return value;
  };
  const command = positionals[0];
  if (v.help || !command) {
    console.log(
      "pnpm apo <generate|validate|supervision|prepare|baseline|run|resume|final|evaluate|label|report|export|register>\n  generate --out dataset.json\n  prepare --out RUN --catalog catalog.json [--dataset dataset.json] [--config config.json] [--smoke]\n  baseline|run|resume|final|report --run RUN\n  evaluate --run RUN --task TASK --prompt prompt.txt (validation only)\n  label --run RUN --strategy deterministic|outcome|human|judge|consensus --out dataset.json\n  export --run RUN --out profile.json\n  register --profile profile.json (registers locally; never activates)\n  validate|supervision --dataset dataset.json",
    );
    return;
  }
  if (command === "generate") {
    const data = validateDataset(generateDataset());
    await write(required("out"), data);
    console.log(supervisionSummary(data));
    return;
  }
  if (command === "validate" || command === "supervision") {
    const data = validateDataset(await read(required("dataset")));
    console.log(supervisionSummary(data));
    if (command === "validate")
      console.log(
        Object.fromEntries(
          Object.entries(splitDataset(data, 20261016)).map(([k, ids]) => [
            k,
            ids.length,
          ]),
        ),
      );
    return;
  }
  if (command === "register") {
    const profile = validateProfile(await read(required("profile")));
    assert.notEqual(profile.id, "baseline");
    const path = join(
      root,
      "lib/maintenance/consolidator/prompt-profiles.json",
    );
    const registry = await read(path);
    assert(
      !Object.hasOwn(registry, profile.id),
      "Profile already registered; never overwrite a version",
    );
    registry[profile.id] = profile;
    await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`);
    console.log(
      `Registered ${profile.id}; activation requires JEV_PROMPT_PROFILE=${profile.id}. Default remains baseline.`,
    );
    return;
  }
  if (command === "prepare") {
    const config = configSchema.parse({
      tasks: [...CORE_PROMPT_TASKS],
      ...(v.config ? await read(v.config) : {}),
      smoke: v.smoke,
    });
    assert.equal(
      new Set(config.tasks).size,
      config.tasks.length,
      "Duplicate task",
    );
    let data = validateDataset(
      v.dataset ? await read(v.dataset) : generateDataset(),
    ).filter((e) => config.tasks.includes(e.task));
    if (config.smoke) {
      const groups = [...new Set(data.map((e) => e.group))];
      const chosen = ["it", "en"].flatMap((language) =>
        groups
          .filter((group) =>
            data.some((e) => e.group === group && e.language === language),
          )
          .slice(0, 5),
      );
      data = data.filter((e) => chosen.includes(e.group));
    }
    const models = validateCatalog(
      await read(required("catalog")),
      config.optimizerModel,
      config.judgeModels,
    );
    const store = new ExperimentStore(required("out"));
    await mkdir(store.dir, { recursive: false });
    const manifest: Manifest = {
      version: 1,
      id: `${new Date().toISOString().slice(0, 10)}-${randomUUID()}`,
      createdAt: new Date().toISOString(),
      config,
      dataset: data,
      datasetHash: fingerprint(data),
      splits: splitDataset(data, config.seed),
      baseline: { ...BASELINE_PROMPTS },
      baselineHash: fingerprint(BASELINE_PROMPTS),
      engineHash: await engineHash(root),
      models,
      decisionModel: JEV_MODEL,
      inference: {
        decision:
          "Gateway evaluate; no unsupported temperature, seed or fallback sent",
        optimizer: {
          systemPrompt: OPTIMIZER_SYSTEM,
          temperature: config.optimizerTemperature,
          max_tokens: config.optimizerMaxTokens,
          response_format: { type: "json_object" },
        },
        repeatPolicy:
          "independent requests; exact same configuration; seed controls split and bootstrap only",
      },
      supervision: supervisionSummary(data),
    };
    await store.write("manifest.json", manifest, true);
    await store.write("manifest-hash.json", fingerprint(manifest), true);
    await store.write("state.json", { tasks: {}, status: "prepared" }, true);
    await report(store, manifest);
    console.log(
      `Prepared ${store.dir}: ${data.length} examples; ${config.smoke ? "SMOKE ONLY" : "full synthetic experiment"}`,
    );
    return;
  }
  const store = new ExperimentStore(required("run"));
  const manifest = await store.read<Manifest>("manifest.json");
  assert.equal(manifest.version, 1);
  assert.equal(
    fingerprint(manifest),
    await store.read("manifest-hash.json"),
    "Manifest changed; prepare a new experiment",
  );
  validateDataset(manifest.dataset);
  validateSplits(manifest.dataset, manifest.splits);
  configSchema.parse(manifest.config);
  assert.equal(fingerprint(manifest.dataset), manifest.datasetHash);
  assert.equal(fingerprint(manifest.baseline), manifest.baselineHash);
  if (command === "report") {
    console.log((await report(store, manifest)).usage);
    return;
  }
  if (command === "export") {
    const frozen = await store.read<FrozenSelection>("frozen.json");
    const profile = validateProfile({
      id: `apo-${manifest.id}`,
      prompts: frozen.prompts,
    });
    await write(required("out"), profile);
    console.log(
      `Exported frozen candidate. Read report.md before activation; no deployment performed.`,
    );
    return;
  }
  assert.equal(
    await engineHash(root),
    manifest.engineHash,
    "Experiment engine changed; prepare a new experiment instead of silently resuming",
  );
  loadEnvConfig(root);
  const unlock = await store.lock();
  try {
    const adapter = new ModelAdapter(store, manifest);
    const experiment = new Experiment(
      store,
      manifest,
      adapter.decision,
      gatewayOptimizer(adapter),
      (message) => console.log(new Date().toISOString(), message),
    );
    if (command === "label") {
      assert(
        !(await store.maybe("frozen.json")),
        "Generate new labels in a separate experiment after test access",
      );
      const strategy = required("strategy");
      let labeler: SupervisionStrategy;
      if (strategy === "judge" || strategy === "consensus") {
        assert(
          manifest.config.judgeModels.length >=
            (strategy === "consensus" ? 2 : 1),
          "Configure independent judgeModels before preparing",
        );
        labeler = llmSupervision(adapter, manifest.config.judgeModels);
      } else {
        assert(
          strategy === "deterministic" ||
            strategy === "human" ||
            strategy === "outcome",
          "Unknown strategy",
        );
        labeler = recordedSupervision(strategy);
      }
      const data = [];
      for (const example of manifest.dataset)
        data.push({ ...example, label: await labeler(example) });
      await write(required("out"), validateDataset(data));
      console.log(
        "Saved a new labeled dataset; prepare a new experiment to use it.",
      );
    } else if (command === "baseline") await experiment.baseline();
    else if (command === "evaluate") {
      assert(
        !(await store.maybe("frozen.json")),
        "Exploratory evaluation is closed after selection freezes",
      );
      const task = required("task") as PromptTask;
      assert(manifest.config.tasks.includes(task));
      await experiment.evaluate(
        task,
        await readFile(resolve(required("prompt")), "utf8"),
        "validation",
      );
    } else if (
      command === "run" ||
      command === "resume" ||
      command === "final"
    ) {
      if (command !== "final") await experiment.search();
      adapter.final = true;
      await experiment.final();
    } else throw new Error(`Unknown command: ${command}`);
    const summary = await report(store, manifest);
    console.log(
      JSON.stringify({
        status: summary.status,
        usage: summary.usage,
        report: store.path("report.md"),
      }),
    );
  } catch (error) {
    await report(store, manifest);
    throw error;
  } finally {
    await unlock();
  }
}
main().catch((error) => {
  console.error(
    error instanceof BudgetStop
      ? "Budget reached; saved artifacts remain resumable within the frozen budget. Final evaluation may be incomplete."
      : error instanceof Error
        ? error.message
        : "APO failed",
  );
  process.exitCode = 1;
});
