import assert from "node:assert/strict";
import { fingerprint } from "../../lib/canonical-json";
import type { PromptTask } from "../../lib/maintenance/consolidator/prompts";
import { eligible } from "./dataset";
import { metrics, pairedInterval, selectCandidate } from "./metrics";
import { BudgetStop, safeFailure } from "./models";
import { representativeErrors, validateProposal } from "./optimizer";
import type { ExperimentStore, Manifest, SearchState } from "./store";
import { classify, requestFor } from "./tasks";
import type {
  DecisionModel,
  Example,
  Optimizer,
  Prediction,
  Split,
} from "./types";

export type FrozenSelection = {
  prompts: Record<PromptTask, string>;
  frozenAt: string;
  stoppedBy: string;
  configHash: string;
  datasetHash: string;
};
export class Experiment {
  constructor(
    readonly store: ExperimentStore,
    readonly manifest: Manifest,
    readonly decision: DecisionModel,
    readonly optimizer: Optimizer,
    readonly log: (message: string) => void = () => {},
  ) {}

  async evaluate(task: PromptTask, prompt: string, split: Split) {
    if (split === "test") {
      const frozen = await this.store.maybe<FrozenSelection>("frozen.json");
      assert(frozen, "Test set is locked until final selection");
      assert(
        frozen.prompts[task] === prompt ||
          this.manifest.baseline[task] === prompt,
        "Only frozen winner and baseline may see test data",
      );
    }
    const ids = new Set(this.manifest.splits[split]);
    const examples = this.manifest.dataset.filter(
      (e) => e.task === task && ids.has(e.id) && eligible(e),
    );
    const promptHash = fingerprint(prompt);
    const predictions: Prediction[] = [];
    const append = (row: Prediction) => {
      predictions.push(row);
      if (
        predictions.length >= 3 &&
        predictions.slice(-3).every((p) => p.error)
      )
        throw new Error(
          "Three consecutive model failures; inspect saved diagnostics before resuming",
        );
    };
    const predict = async (
      example: Example,
      repeat: number,
    ): Promise<Prediction> => {
      const id = fingerprint({
        task,
        promptHash,
        split,
        example: example.id,
        repeat,
      });
      const path = `predictions/${id}.json`;
      const saved = await this.store.maybe<Prediction>(path);
      if (saved) {
        assert.equal(saved.promptHash, promptHash);
        return saved;
      }
      const started = performance.now();
      const row: Prediction = {
        id,
        exampleId: example.id,
        task,
        split,
        promptHash,
        repeat,
        expected: example.label.value,
        predicted: "error",
        probability: null,
        answer: null,
        model: this.manifest.decisionModel,
        language: example.language,
        category: example.category,
        group: example.group,
        origin: example.origin,
        supervision: example.label,
        latencyMs: 0,
        inputTokens: null,
        outputTokens: null,
        costDollars: null,
        error: null,
      };
      try {
        const result = await this.decision(
          requestFor(example, prompt),
          `prediction:${id}`,
        );
        row.answer = result.answer;
        row.predicted = classify(task, result.answer, example.context);
        row.probability =
          result.answer.type === "boolean" ? result.answer.probability : null;
        row.model = result.model;
        row.inputTokens = result.inputTokens;
        row.outputTokens = result.outputTokens;
        row.costDollars = result.costDollars;
        row.latencyMs = result.latencyMs ?? performance.now() - started;
      } catch (error) {
        if (error instanceof BudgetStop) throw error;
        row.error = safeFailure(error);
        row.latencyMs = performance.now() - started;
      }
      await this.store.write(path, row, true);
      return row;
    };
    const jobs = Array.from(
      { length: this.manifest.config.repeats },
      (_, repeat) => examples.map((example) => ({ example, repeat })),
    ).flat();
    const concurrency = this.manifest.config.concurrency ?? 1;
    for (let start = 0; start < jobs.length; start += concurrency) {
      const completed = await Promise.allSettled(
        jobs
          .slice(start, start + concurrency)
          .map(({ example, repeat }) => predict(example, repeat)),
      );
      // Every in-flight result has been persisted before a stop can propagate.
      for (const result of completed) {
        if (result.status === "rejected") throw result.reason;
        append(result.value);
        if (predictions.length % 50 === 0)
          this.log(`${task} ${split}: ${predictions.length}/${jobs.length}`);
      }
    }
    await this.store.write(
      `metrics/${task}-${promptHash}-${split}.json`,
      metrics(task, predictions),
    );
    return predictions;
  }

  async baseline() {
    for (const task of this.manifest.config.tasks) {
      this.log(`Baseline ${task}`);
      await this.evaluate(task, this.manifest.baseline[task], "train");
      await this.evaluate(task, this.manifest.baseline[task], "validation");
    }
  }

  async search() {
    if (await this.store.maybe("frozen.json")) return;
    const state = (await this.store.maybe<SearchState>("state.json")) ?? {
      tasks: {},
      status: "prepared",
    };
    state.status = "searching";
    let stoppedBy = "search_complete";
    const save = () => this.store.write("state.json", state);
    try {
      for (const task of this.manifest.config.tasks) {
        this.log(`Baseline ${task}`);
        await this.evaluate(task, this.manifest.baseline[task], "train");
        await this.evaluate(task, this.manifest.baseline[task], "validation");
        const current = state.tasks[task] ?? {
          prompt: this.manifest.baseline[task],
          iteration: 0,
          stale: 0,
          done: false,
          history: [],
        };
        state.tasks[task] = current;
        while (
          !current.done &&
          current.iteration < this.manifest.config.iterations
        ) {
          const training = await this.evaluate(task, current.prompt, "train");
          const technicalFailures = training.filter((r) => r.error).length;
          if (technicalFailures === training.length) {
            current.done = true;
            current.stoppedBy = "no_valid_training_predictions";
            break;
          }
          if (technicalFailures)
            this.log(
              `${task}: excluding ${technicalFailures}/${training.length} technical failures from optimizer feedback; retaining them in metrics and call accounting`,
            );
          const errors = representativeErrors(
            this.manifest.dataset.filter((e) =>
              this.manifest.splits.train.includes(e.id),
            ),
            training,
            this.manifest.config.maxErrors,
          );
          if (!errors.length) {
            current.done = true;
            current.stoppedBy = technicalFailures
              ? "no_semantic_errors_in_valid_training"
              : "no_training_errors";
            break;
          }
          const iteration = current.iteration + 1;
          this.log(
            `Optimizer ${task}, iteration ${iteration}, ${errors.length} training failures`,
          );
          const input = {
            task,
            currentPrompt: current.prompt,
            errors,
            previous: current.history.map((h) => ({
              changes: h.proposal?.changes ?? [],
              reason: h.reasons,
            })),
            maxCharacters: this.manifest.config.maxPromptCharacters,
            maxTokens: this.manifest.config.maxPromptTokens,
          };
          const artifact = `candidates/${task}-${iteration}.json`;
          let proposal =
            await this.store.maybe<Awaited<ReturnType<Optimizer>>>(artifact);
          let invalidReason: string | null = null;
          try {
            if (!proposal) {
              proposal = await this.optimizer(
                input,
                `optimizer:${task}:${iteration}`,
              );
              await this.store.write(artifact, proposal, true);
            }
            validateProposal(proposal, input);
          } catch (error) {
            if (error instanceof BudgetStop) throw error;
            invalidReason =
              error instanceof Error &&
              /^(candidate_|Prompt )/.test(error.message)
                ? error.message
                : "optimizer_response_failure";
          }
          if (!proposal || invalidReason) {
            current.history.push({
              proposal,
              accepted: false,
              reasons: [invalidReason ?? "optimizer_response_failure"],
            });
            current.stale++;
          } else {
            const previous = await this.evaluate(
              task,
              current.prompt,
              "validation",
            );
            const candidate = await this.evaluate(
              task,
              proposal.candidate_prompt,
              "validation",
            );
            const selection = selectCandidate(
              task,
              previous,
              candidate,
              this.manifest.config,
            );
            await this.store.write(
              `selection/${task}-${iteration}.json`,
              selection,
            );
            current.history.push({
              proposal,
              accepted: selection.accepted,
              reasons: selection.reasons,
              promptHash: fingerprint(proposal.candidate_prompt),
            });
            if (selection.accepted) {
              current.prompt = proposal.candidate_prompt;
              current.stale = 0;
            } else current.stale++;
            this.log(
              `${task}: ${selection.before.macroF1.toFixed(4)} -> ${selection.after.macroF1.toFixed(4)}, ${selection.accepted ? "accepted" : selection.reasons.join(", ")}`,
            );
          }
          current.iteration = iteration;
          if (current.stale >= this.manifest.config.patience) {
            current.done = true;
            current.stoppedBy = "patience";
          }
          await save();
        }
        current.done = true;
        current.stoppedBy ??= "iteration_limit";
        await save();
      }
    } catch (error) {
      if (!(error instanceof BudgetStop)) throw error;
      stoppedBy = "search_budget";
      this.log("Search budget reached; freezing best validated prompts");
    }
    const prompts = { ...this.manifest.baseline };
    for (const task of this.manifest.config.tasks)
      prompts[task] = state.tasks[task]?.prompt ?? this.manifest.baseline[task];
    const frozen: FrozenSelection = {
      prompts,
      frozenAt: new Date().toISOString(),
      stoppedBy,
      configHash: fingerprint(this.manifest.config),
      datasetHash: this.manifest.datasetHash,
    };
    await this.store.write("frozen.json", frozen, true);
    state.status = "frozen";
    await save();
  }

  async final() {
    const frozen = await this.store.read<FrozenSelection>("frozen.json");
    assert.equal(frozen.configHash, fingerprint(this.manifest.config));
    assert.equal(frozen.datasetHash, this.manifest.datasetHash);
    for (const task of this.manifest.config.tasks) {
      if (await this.store.maybe(`final/${task}.json`)) continue;
      this.log(`Held-out final evaluation: ${task}`);
      const baseline = await this.evaluate(
        task,
        this.manifest.baseline[task],
        "test",
      );
      const selected = await this.evaluate(task, frozen.prompts[task], "test");
      const before = metrics(task, baseline),
        after = metrics(task, selected);
      const interval = pairedInterval(
        task,
        baseline,
        selected,
        this.manifest.config.seed,
      );
      const delta = after.macroF1 - before.macroF1;
      const selectedByKey = new Map(
        selected.map((r) => [`${r.exampleId}:${r.repeat}`, r]),
      );
      const corrected = baseline
        .filter(
          (r) =>
            r.predicted !== r.expected &&
            selectedByKey.get(`${r.exampleId}:${r.repeat}`)?.predicted ===
              r.expected,
        )
        .map((r) => r.exampleId);
      const regressions = baseline
        .filter(
          (r) =>
            r.predicted === r.expected &&
            selectedByKey.get(`${r.exampleId}:${r.repeat}`)?.predicted !==
              r.expected,
        )
        .map((r) => r.exampleId);
      const operational = selectCandidate(
        task,
        baseline,
        selected,
        this.manifest.config,
      );
      await this.store.write(
        `final/${task}.json`,
        {
          before,
          after,
          delta,
          relativeDelta: before.macroF1 ? delta / before.macroF1 : null,
          interval,
          corrected: [...new Set(corrected)],
          regressions: [...new Set(regressions)],
          recommendation:
            !this.manifest.config.smoke &&
            delta >= this.manifest.config.minImprovement &&
            interval.lower > 0 &&
            operational.accepted
              ? "candidate_for_review"
              : "retain_baseline",
          limitations:
            "Synthetic cases establish performance only on constructed examples. Repeats and variants are clustered by source. This is not production accuracy or human validation. Test results never feed another optimizer iteration.",
        },
        true,
      );
    }
    const state = await this.store.read<SearchState>("state.json");
    state.status = "complete";
    await this.store.write("state.json", state);
  }
}
