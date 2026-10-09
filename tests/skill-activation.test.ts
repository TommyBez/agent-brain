import assert from "node:assert/strict";
import test from "node:test";
import {
  activationBundle,
  activationPrompt,
  activationSummary,
  scoreActivation,
} from "../scripts/skill-eval/activation";
import { activationScenarios } from "../scripts/skill-eval/activation-dataset";
import { FakeBrain } from "../scripts/skill-eval/brain";
import { validateDataset } from "../scripts/skill-eval/dataset";
import type { Session } from "../scripts/skill-eval/evaluate";

const bundle = activationBundle({
  files: {
    "SKILL.md":
      "---\nname: brain-memory\ndescription: Retrieve personal context.\n---\nPRIVATE_SKILL_BODY",
    "references/writing-pages.md": "PRIVATE_REFERENCE",
  },
  instructions: "PRIVATE_SERVER_INSTRUCTIONS",
});

function trial(index: number) {
  const scenario = activationScenarios[index];
  const brain = new FakeBrain(scenario.initial, bundle.files);
  const session: Session = {
    id: "test",
    bundle,
    initial: scenario.initial,
    pages: brain.pages,
    trace: brain.trace,
    status: "completed",
    final: "Answer",
    maxCalls: 40,
    mode: "discovery",
    model: "test-model",
  };
  return { scenario, brain, session };
}

test("activation prompts expose the frozen catalog without loading procedures or leaking labels; successful skill reads drive the score", () => {
  validateDataset(activationScenarios);
  assert.equal(activationScenarios.length, 20);
  assert.equal(
    activationScenarios.filter((c) => c.activation?.shouldActivate).length,
    10,
  );
  const { scenario, brain, session } = trial(1);
  const prompt = activationPrompt(scenario.request, bundle, "LOCAL_COMMAND");
  assert(prompt.includes(scenario.request));
  assert(prompt.includes("text-editing/SKILL.md"));
  assert(prompt.includes("brain-memory/SKILL.md"));
  assert(!prompt.includes("PRIVATE_"));
  assert(!prompt.includes(scenario.activation?.rationale ?? "missing"));
  assert(!prompt.includes("Expected activation"));
  assert(!prompt.includes("using the available local Brain tools"));
  assert(!prompt.includes("references/decisions.md"));
  brain.call("read_skill", { path: "brain-memory/SKILL.md" });
  brain.call("context", { query: "Portale Iris" });
  const scored = scoreActivation(scenario, session);
  assert.equal(scored.outcome, "TP");
  assert.equal(scored.firstLoadCall, 1);
  assert.equal(scored.successfulBrainCalls, 1);
  assert.equal(scored.brainCallsBeforeLoad, 0);
  assert.equal(scored.successfulWrites, 0);
});

test("direct service use, failed loads, unrelated skills and incomplete sessions cannot masquerade as correct activation", () => {
  const positive = trial(1);
  positive.brain.call("context", { query: "Portale Iris" });
  positive.brain.call("read_skill", { path: "brain-memory/missing.md" });
  positive.brain.call("read_skill", {
    path: "brain-memory/references/writing-pages.md",
  });
  positive.brain.call("read_skill", { path: "text-editing/SKILL.md" });
  positive.session.final = "I used brain-memory";
  const missed = scoreActivation(positive.scenario, positive.session);
  assert.equal(missed.outcome, "FN");
  assert.equal(missed.brainCallsBeforeLoad, 1);
  assert.deepEqual(missed.otherSkillsLoaded, ["text-editing/SKILL.md"]);
  const negative = trial(10);
  assert.equal(
    scoreActivation(negative.scenario, negative.session).outcome,
    "TN",
  );
  negative.brain.call("read_skill", { path: "brain-memory/SKILL.md" });
  const extra = scoreActivation(negative.scenario, negative.session);
  assert.equal(extra.outcome, "FP");
  negative.session.status = "error";
  const incomplete = scoreActivation(negative.scenario, negative.session);
  assert.equal(incomplete.outcome, null);
  const common = { caseId: "test", variant: "candidate", repeat: 1 };
  const summary = activationSummary([
    { ...common, status: "completed", activation: missed },
    { ...common, status: "completed", activation: extra },
    { ...common, status: "error", activation: incomplete },
    { ...common, status: "pending", activation: null },
  ]);
  assert.equal(summary.completed, 2);
  assert.equal(summary.pending, 1);
  assert.equal(summary.incomplete, 1);
  assert.equal(summary.FN, 1);
  assert.equal(summary.FP, 1);
  assert.equal(summary.recall, 0);
  assert.equal(summary.falsePositiveRate, 1);
  assert.equal(activationSummary([]).precision, null);
});
