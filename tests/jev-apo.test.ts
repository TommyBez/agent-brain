import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fingerprint } from "../lib/canonical-json";
import { JEV_MODEL } from "../lib/maintenance/consolidator/jev";
import {
  BASELINE_PROFILE,
  BASELINE_PROMPTS,
  CORE_PROMPT_TASKS,
  EVIDENCE_RULES,
  promptPolicyVersion,
  renderPrompt,
  resolvePromptProfile,
  validateProfile,
} from "../lib/maintenance/consolidator/prompts";
import {
  preparationQuestions,
  screeningQuestions,
} from "../lib/maintenance/consolidator/questions";
import { VERIFICATION_EVIDENCE_RULE } from "../lib/maintenance/consolidator/verifier";
import {
  type GatewayCall,
  GatewayRequestError,
} from "../lib/maintenance/gateway";
import {
  eligible,
  splitDataset,
  validateDataset,
  validateSplits,
} from "../scripts/apo/dataset";
import { generateDataset } from "../scripts/apo/fixtures";
import {
  averagePrecision,
  classification,
  metrics,
  pairedInterval,
  selectCandidate,
} from "../scripts/apo/metrics";
import { BudgetStop, ModelAdapter, providerUsage } from "../scripts/apo/models";
import {
  optimizerPayload,
  parseChatJson,
  representativeErrors,
  validateProposal,
} from "../scripts/apo/optimizer";
import { report } from "../scripts/apo/report";
import { Experiment } from "../scripts/apo/runner";
import { ExperimentStore, type Manifest } from "../scripts/apo/store";
import {
  consensus,
  judgePayload,
  judgeSchema,
} from "../scripts/apo/supervision";
import { classify, requestFor } from "../scripts/apo/tasks";
import {
  configSchema,
  type DecisionModel,
  type OptimizerInput,
  type Prediction,
} from "../scripts/apo/types";
import { generateContractDataset } from "../scripts/jev-contract-dataset";
import { generateLinkDataset } from "../scripts/jev-link-dataset";
import {
  generateMissingDataset,
  MISSING_TASK_ORDER,
} from "../scripts/jev-missing-dataset";
import { generateResolutionDataset } from "../scripts/jev-resolution-dataset";
import {
  verifierAuditCases,
  verifierAuditIdentity,
} from "../scripts/jev-verifier-audit";

test("whole-verifier audit resumes across capture times without accepting changed evidence or labels", () => {
  const original = verifierAuditCases();
  const replay = structuredClone(original);
  for (const fixture of replay)
    fixture.snapshot.createdAt = "2030-01-01T00:00:00Z";
  assert.equal(verifierAuditIdentity(original), verifierAuditIdentity(replay));
  replay[0].snapshot.pages[0].markdown +=
    " Nuovo fatto non presente in origine.";
  assert.notEqual(
    verifierAuditIdentity(original),
    verifierAuditIdentity(replay),
  );
  const relabeled = structuredClone(original);
  relabeled[0].expected = !relabeled[0].expected;
  assert.notEqual(
    verifierAuditIdentity(original),
    verifierAuditIdentity(relabeled),
  );
});

test("contract follow-up includes event destinations and existing links for every relation with fresh source groups", () => {
  const examples = generateContractDataset();
  assert.equal(examples.length, 1060);
  assert(
    examples.every(
      (e) => e.language === "it" && e.group.startsWith("contract-it-v1-"),
    ),
  );
  const splits = splitDataset(examples, 20261020);
  assert.deepEqual(
    Object.values(splits).map((ids) => ids.length),
    [636, 212, 212],
  );
  for (const ids of Object.values(splits)) {
    const rows = examples.filter((e) => ids.includes(e.id));
    assert.equal(
      new Set(
        rows
          .filter((e) => e.category.startsWith("existing-"))
          .map((e) => e.category),
      ).size,
      9,
    );
    assert(
      rows
        .filter((e) => e.category.startsWith("existing-"))
        .every((e) => e.label.value === "none"),
    );
    assert(
      rows
        .filter((e) => e.category.startsWith("event-"))
        .every((e) => e.label.value !== "none"),
    );
    assert.equal(
      new Set(rows.map((e) => e.group)).size,
      ids === splits.train ? 12 : 4,
    );
  }
});

test("all remaining tasks use Italian source families, fixed verifier requirements and disjoint complete splits", async () => {
  const examples = await generateMissingDataset();
  assert.equal(examples.length, 2660);
  assert.equal(new Set(examples.map((e) => e.group)).size, 20);
  assert.deepEqual(
    [...new Set(examples.map((e) => e.task))].sort(),
    [...MISSING_TASK_ORDER].sort(),
  );
  assert(
    examples.every((e) => e.language === "it" && e.origin === "synthetic"),
  );
  const oldGroups = new Set(
    [...data, ...generateLinkDataset(), ...generateResolutionDataset()].map(
      (e) => e.group,
    ),
  );
  assert(examples.every((e) => !oldGroups.has(e.group)));
  assert.equal(
    fingerprint(examples),
    fingerprint(await generateMissingDataset()),
  );
  const splits = splitDataset(examples, 20261019);
  assert.deepEqual(
    Object.values(splits).map((ids) => ids.length),
    [1596, 532, 532],
  );
  for (const ids of Object.values(splits)) {
    const rows = examples.filter((e) => ids.includes(e.id));
    assert.equal(
      new Set(
        rows.filter((e) => e.task === "verification").map((e) => e.category),
      ).size,
      60,
    );
    for (const task of MISSING_TASK_ORDER)
      assert(rows.some((e) => e.task === task));
  }
  for (const example of examples.filter((e) => e.task === "verification")) {
    const question = requestFor(example, "").questions.decision;
    assert.equal(
      question.instructions,
      `${VERIFICATION_EVIDENCE_RULE} ${example.context?.verification?.requirement}`,
    );
    assert.equal(
      JSON.stringify(question).includes(example.label.rationale),
      false,
    );
  }
});

test("legacy profiles retain their cache identity and use unchanged defaults for extended tasks", () => {
  const legacy = {
    id: "legacy",
    prompts: Object.fromEntries(
      CORE_PROMPT_TASKS.map((task) => [task, BASELINE_PROMPTS[task]]),
    ),
  };
  const parsed = validateProfile(legacy);
  assert.deepEqual(parsed, legacy);
  assert.equal(fingerprint(parsed.prompts), fingerprint(legacy.prompts));
  assert.equal(renderPrompt("verification", {}, parsed), "");
  assert.equal(
    renderPrompt("localize_conflict", { index: "3" }, parsed),
    BASELINE_PROMPTS.localize_conflict.replace("{index}", "3"),
  );
  assert.equal(
    classify("localize_conflict", { type: "boolean", probability: 0.69 }),
    "false",
  );
  assert.equal(
    classify("localize_conflict", { type: "boolean", probability: 0.7 }),
    "true",
  );
  const context = (questionId: string) => ({
    verification: { questionId, requirement: "Fixed application requirement" },
  });
  assert.equal(
    classify(
      "verification",
      { type: "boolean", probability: 0.65 },
      context("support_0"),
    ),
    "true",
  );
  assert.equal(
    classify(
      "verification",
      { type: "boolean", probability: 0.79 },
      context("objective"),
    ),
    "false",
  );
  assert.equal(
    classify(
      "verification",
      { type: "boolean", probability: 0.8 },
      context("objective"),
    ),
    "true",
  );
});

test("fresh Italian resolution corpus covers all six choices with disjoint source families and exact targets", () => {
  const examples = generateResolutionDataset();
  assert.equal(examples.length, 180);
  assert.equal(new Set(examples.map((e) => e.group)).size, 30);
  assert.equal(fingerprint(examples), fingerprint(generateResolutionDataset()));
  const oldGroups = new Set(
    [...generateDataset(), ...generateLinkDataset()].map((e) => e.group),
  );
  assert(
    examples.every(
      (e) =>
        !oldGroups.has(e.group) &&
        e.language === "it" &&
        e.task === "resolution",
    ),
  );
  const splits = splitDataset(examples, 20261018);
  assert.deepEqual(
    Object.values(splits).map((ids) => ids.length),
    [108, 36, 36],
  );
  for (const ids of Object.values(splits)) {
    const rows = examples.filter((e) => ids.includes(e.id));
    assert.deepEqual([...new Set(rows.map((e) => e.label.value))].sort(), [
      "a",
      "b",
      "insufficient",
      "none",
      "scope",
      "temporal",
    ]);
    assert(rows.some((e) => e.pair));
    assert(rows.some((e) => !e.pair));
    assert(rows.some((e) => e.direct));
  }
});

test("expanded Italian relationship corpus covers target evidence and keeps new source families disjoint", () => {
  const examples = generateLinkDataset();
  assert.equal(examples.length, 200);
  assert.equal(new Set(examples.map((e) => e.group)).size, 20);
  assert(examples.every((e) => e.language === "it" && e.task === "link"));
  const oldGroups = new Set(generateDataset().map((e) => e.group));
  assert(examples.every((e) => !oldGroups.has(e.group)));
  const splits = splitDataset(examples, 20261017);
  assert.deepEqual(
    Object.values(splits).map((ids) => ids.length),
    [120, 40, 40],
  );
  for (const ids of Object.values(splits)) {
    const rows = examples.filter((e) => ids.includes(e.id));
    assert.equal(new Set(rows.map((e) => e.category)).size, 10);
    assert(rows.some((e) => e.direction === "ab"));
    assert(rows.some((e) => e.direction === "ba"));
  }
  for (const example of examples.filter(
    (e) =>
      e.category === "target-employment" || e.category === "target-ownership",
  )) {
    const state = example.state as {
      pages: { title: string; markdown: string }[];
    };
    const [source, target] =
      example.direction === "ab" ? state.pages : [...state.pages].reverse();
    assert(!source.markdown.includes(target.title));
    assert(target.markdown.includes(source.title));
    assert.equal(example.label.value, "true");
  }
});

const data = validateDataset(generateDataset());
const config = configSchema.parse({ tasks: ["residue"], repeats: 2 });
const label = data[0].label;
function row(expected: string, predicted: string, index = 0): Prediction {
  return {
    id: String(index),
    exampleId: `case-${index}`,
    task: "residue",
    split: "validation",
    promptHash: "p",
    repeat: 0,
    expected,
    predicted,
    probability: predicted === "true" ? 0.9 : 0.1,
    answer: { type: "boolean", probability: 0.1 },
    model: JEV_MODEL,
    language: "it",
    category: "mixed",
    group: `group-${index}`,
    origin: "synthetic",
    supervision: { ...label, value: expected },
    latencyMs: 10,
    inputTokens: 100,
    outputTokens: 0,
    costDollars: 0.0000042,
    error: null,
  };
}
function manifest(): Manifest {
  const dataset = data.filter(
    (e) => e.task === "residue" && Number(e.group.slice(-2)) < 10,
  );
  return {
    version: 1,
    id: "test",
    createdAt: "2026-10-16",
    config,
    dataset,
    datasetHash: fingerprint(dataset),
    splits: splitDataset(dataset, 10),
    baseline: BASELINE_PROMPTS,
    baselineHash: fingerprint(BASELINE_PROMPTS),
    engineHash: "test",
    models: [
      { id: JEV_MODEL, pricing: { input: "0.000000042", output: "0" } },
      {
        id: config.optimizerModel,
        pricing: { input: "0.0000003", output: "0.0000012" },
      },
    ],
    decisionModel: JEV_MODEL,
    inference: {},
    supervision: {},
  };
}
const proposal = (prompt: string) => ({
  candidate_prompt: prompt,
  changes: ["Recognize agent activity"],
  targeted_failure_modes: ["false negative"],
  rationale: "Training contains missed activity logs",
  potential_regressions: ["Original owner requests"],
  hypothesis: "Recall improves without deleting original requests",
});

test("Italian synthetic generation is stable and every source/near duplicate stays in one split", () => {
  assert.equal(
    fingerprint(data),
    fingerprint(validateDataset(generateDataset())),
  );
  assert.equal(data.length, 630);
  assert(
    data.every(
      (e) =>
        e.language === "it" &&
        e.origin === "synthetic" &&
        e.label.status === "constructed",
    ),
  );
  const split = splitDataset(data, 20261016);
  assert.deepEqual(
    Object.values(split).map((ids) => ids.length),
    [378, 126, 126],
  );
  assert.deepEqual(split, splitDataset(data, 20261016));
  assert.notDeepEqual(split, splitDataset(data, 10));
  const copy = { ...data[0], id: "new-copy", group: "unrelated-id" };
  const withCopy = splitDataset([...data, copy], 20261016);
  assert(
    Object.values(withCopy).some(
      (ids) => ids.includes(copy.id) && ids.includes(data[0].id),
    ),
  );
  const broken = structuredClone(split);
  broken.validation.push(broken.train.pop() as string);
  assert.throws(() => validateSplits(data, broken), /Source leaked/);
  assert.throws(() => validateDataset([...data, data[0]]), /Duplicate example/);
  assert.throws(
    () =>
      validateDataset([{ ...data[0], label: { ...label, value: "invented" } }]),
    /Invalid label/,
  );
  assert.equal(
    eligible({ ...data[0], label: { ...label, status: "uncertain" } }),
    false,
  );
  assert.equal(
    eligible({ ...data[0], label: { ...label, agreement: 0.5 } }),
    false,
  );
});

test("baseline byte identity, immutable evidence rules, prompt cache identity and rollback", () => {
  const expected =
    "Is there substantial repeated factual information across pages[0] and pages[1] that could benefit from consolidation? Shared topic alone is not duplication. Identify existence, not a specific deletion." +
    EVIDENCE_RULES;
  assert.equal(
    screeningQuestions(true, BASELINE_PROFILE).duplicate.instructions,
    expected,
  );
  assert.equal(resolvePromptProfile("baseline").id, "baseline");
  assert.throws(() => resolvePromptProfile("missing-profile"));
  assert.equal(promptPolicyVersion("v5", BASELINE_PROFILE), "v5");
  const candidate = {
    id: "candidate",
    prompts: {
      ...BASELINE_PROMPTS,
      residue: `${BASELINE_PROMPTS.residue} Distinguish the author of each request.`,
    },
  };
  assert.notEqual(promptPolicyVersion("v5", candidate), "v5");
  assert.notEqual(
    promptPolicyVersion("v5", candidate),
    promptPolicyVersion("v5", {
      ...candidate,
      prompts: {
        ...candidate.prompts,
        residue: `${candidate.prompts.residue} Preserve attribution.`,
      },
    }),
  );
  assert.equal(
    promptPolicyVersion("v5", resolvePromptProfile("baseline")),
    "v5",
  );
  assert.throws(
    () => validateProfile({ ...candidate, id: "baseline" }),
    /immutable/,
  );
  assert.throws(
    () => renderPrompt("link", {}, BASELINE_PROFILE),
    /Missing prompt slot/,
  );
  const e = data.find((e) => e.task === "link") as (typeof data)[number];
  const request = requestFor({ ...e, direction: "ba" }, BASELINE_PROMPTS.link);
  assert.match(
    request.questions.decision.instructions,
    /from pages\[1\] to pages\[0\]/,
  );
  assert.equal(JSON.stringify(request).includes(e.label.rationale), false);
});

test("classification uses fixed thresholds and counts abstentions and technical errors as failures", () => {
  assert.equal(
    classify("residue", { type: "boolean", probability: 0.79 }),
    "false",
  );
  assert.equal(
    classify("residue", { type: "boolean", probability: 0.8 }),
    "true",
  );
  assert.equal(
    classify("resolution", {
      type: "choice",
      choice: "a",
      probabilities: { a: 0.79, b: 0.21 },
      confidence: 1,
    }),
    "abstain",
  );
  const rows = [
    row("true", "true", 0),
    row("true", "false", 1),
    row("false", "true", 2),
    row("false", "false", 3),
  ];
  const result = classification(rows, ["false", "true"]);
  assert.equal(result.accuracy, 0.5);
  assert.equal(result.macroF1, 0.5);
  assert.equal(result.confusion.true.false, 1);
  assert.equal(metrics("residue", rows).falsePositiveRate, 0.5);
  assert.equal(averagePrecision(rows), 0.5);
  assert.equal(
    averagePrecision([{ ...rows[0], error: "timeout", probability: null }]),
    null,
  );
  const failed = metrics("residue", [
    { ...rows[0], predicted: "error", error: "timeout" },
  ]);
  assert.equal(failed.accuracy, 0);
  assert.equal(failed.formatSuccess, 0);
});

test("candidate selection rejects safety regressions, failures, latency and unpaired data", () => {
  const baseline = [
    row("true", "false", 0),
    row("false", "false", 1),
    row("true", "true", 2),
    row("false", "false", 3),
  ];
  const better = baseline.map((r) => ({ ...r, predicted: r.expected }));
  assert.equal(
    selectCandidate("residue", baseline, better, config).accepted,
    true,
  );
  const unsafe = better.map((r, i) =>
    i === 1 ? { ...r, predicted: "true" } : r,
  );
  assert(
    selectCandidate("residue", baseline, unsafe, config).reasons.includes(
      "false_positive_regression",
    ),
  );
  const slow = better.map((r) => ({ ...r, latencyMs: 11000 }));
  assert(
    selectCandidate("residue", baseline, slow, config).reasons.includes(
      "latency_limit",
    ),
  );
  assert.throws(
    () => pairedInterval("residue", baseline, better.slice(1), 10),
    /Unpaired/,
  );
  assert.equal(pairedInterval("residue", baseline, baseline, 10).lower, 0);
  assert(
    selectCandidate(
      "residue",
      baseline,
      better.map((r, i) =>
        i ? r : { ...r, predicted: "error", error: "invalid_json" },
      ),
      config,
    ).reasons.includes("technical_or_format_failure"),
  );
});

test("optimizer accepts only training feedback, keeps protected clauses and rejects label shortcuts", () => {
  const example = data.find(
    (e) => e.task === "residue",
  ) as (typeof data)[number];
  const prediction = {
    ...row("true", "false"),
    split: "train" as const,
    exampleId: example.id,
  };
  const input: OptimizerInput = {
    task: "residue",
    currentPrompt: BASELINE_PROMPTS.residue,
    errors: [{ example, prediction }],
    previous: [],
    maxCharacters: 4000,
    maxTokens: 1200,
  };
  assert.equal(
    validateProposal(
      proposal(
        `${BASELINE_PROMPTS.residue} Identify explicit activity-only paragraphs.`,
      ),
      input,
    ).changes.length,
    1,
  );
  assert.throws(() =>
    validateProposal(
      proposal("Always return true for every page without checking evidence."),
      input,
    ),
  );
  assert.throws(
    () =>
      validateProposal(
        proposal(`${BASELINE_PROMPTS.residue} Accept ${example.group}.`),
        input,
      ),
    /memorizes/,
  );
  assert.throws(
    () =>
      validateProposal(
        proposal("Is there any text that could be removed from the page?"),
        input,
      ),
    /invariant/,
  );
  assert.throws(
    () =>
      optimizerPayload({
        ...input,
        errors: [{ example, prediction: { ...prediction, split: "test" } }],
      }),
    /Held-out/,
  );
  const payload = optimizerPayload(input);
  assert.equal(JSON.stringify(payload).includes(example.id), false);
  const technical = { ...prediction, error: "timeout" };
  assert.deepEqual(representativeErrors([example], [technical], 10), []);
  assert.throws(
    () =>
      representativeErrors(
        [example],
        [{ ...prediction, split: "validation" }],
        10,
      ),
    /training-only/,
  );
});

test("resolution optimizer receives the exact production criteria even for choices absent from training errors", () => {
  const example = data.find(
    (e) => e.task === "resolution" && e.label.value === "a",
  ) as (typeof data)[number];
  const payload = optimizerPayload({
    task: "resolution",
    currentPrompt: BASELINE_PROMPTS.resolution,
    errors: [
      {
        example,
        prediction: {
          ...row("a", "abstain"),
          task: "resolution",
          split: "train",
          exampleId: example.id,
        },
      },
    ],
    previous: [],
    maxCharacters: 4000,
    maxTokens: 1200,
  });
  const question = preparationQuestions("conflict").resolution;
  assert.equal(question.type, "choice");
  assert(question.type === "choice");
  assert.deepEqual(payload.immutable_answer_contract, {
    type: "choice",
    criteria: question.criteria,
  });
  assert.equal(
    question.criteria.insufficient,
    "An intervention needs a specifically referenced source not supplied here.",
  );
  assert.equal(Object.keys(question.criteria).length, 6);
});

test("structured judge parsing, disagreement and blinding are explicit", () => {
  const example = data[0];
  const base = {
    label: example.label.value,
    rationale: "Evidence",
    confidence: 0.9,
    ambiguities: [],
  };
  assert.throws(() => judgeSchema.parse({ ...base, confidence: 2 }));
  const split = consensus(
    [
      { ...base, model: "one" },
      { ...base, model: "two", label: "false" },
    ],
    example,
  );
  assert.equal(split.agreement, 0.5);
  assert.equal(split.status, "uncertain");
  assert.throws(
    () =>
      consensus(
        [
          { ...base, model: "one" },
          { ...base, model: "one" },
        ],
        example,
      ),
    /distinct/,
  );
  assert.equal(
    consensus(
      [
        { ...base, model: "one" },
        { ...base, model: "two" },
      ],
      example,
    ).status,
    "estimated",
  );
  const payload = JSON.stringify(judgePayload(example));
  assert(!payload.includes(example.label.rationale));
  assert(!payload.includes("candidate_prompt"));
  assert.deepEqual(
    parseChatJson({
      choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
    }),
    { ok: true },
  );
  assert.throws(() =>
    parseChatJson({
      choices: [{ finish_reason: "length", message: { content: "{}" } }],
    }),
  );
  assert.throws(() =>
    parseChatJson({
      choices: [{ finish_reason: "stop", message: { content: "not JSON" } }],
    }),
  );
});

test("budget is reserved before calls, persisted on timeout and never silently retried", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-apo-budget-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExperimentStore(dir);
  const m = manifest();
  let attempts = 0;
  const fail: GatewayCall = async () => {
    attempts++;
    throw new GatewayRequestError("timeout", {
      reason: "timeout",
      retryable: true,
    });
  };
  const adapter = new ModelAdapter(store, m, fail);
  await assert.rejects(() =>
    adapter.call(
      "evaluate",
      { model: JEV_MODEL, state: "x", questions: {} },
      "one",
    ),
  );
  assert.equal((await store.calls())[0].status, "error");
  const resumed = new ModelAdapter(store, m, fail);
  await assert.rejects(() =>
    resumed.call(
      "evaluate",
      { model: JEV_MODEL, state: "x", questions: {} },
      "one",
    ),
  );
  assert.equal(attempts, 1);
  const limited = new ModelAdapter(
    store,
    { ...m, config: { ...m.config, maxCalls: 1 } },
    fail,
  );
  await assert.rejects(
    () => limited.call("evaluate", { model: JEV_MODEL }, "two"),
    BudgetStop,
  );
  assert.equal(attempts, 1);
  assert.equal(
    providerUsage({
      usage: { prompt_tokens: 12, completion_tokens: 3, cost: "0.1" },
    }).costDollars,
    0.1,
  );
  assert.equal(
    providerUsage({ usage: { inputTokens: null, outputTokens: null } })
      .inputTokens,
    undefined,
  );
});

test("successful model responses are reused after interruption without duplicate paid requests", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-apo-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExperimentStore(dir);
  const m = manifest();
  let calls = 0;
  const send: GatewayCall = async <T>() => {
    calls++;
    return {
      model: JEV_MODEL,
      answers: { decision: { type: "boolean", probability: 0.9 } },
      usage: { inputTokens: 100, outputTokens: 0 },
      providerMetadata: { gateway: { cost: "0.0000042" } },
    } as T;
  };
  const req = requestFor(data[0], BASELINE_PROMPTS.duplicate);
  await new ModelAdapter(store, m, send).decision(req, "stable-id");
  await new ModelAdapter(store, m, send).decision(req, "stable-id");
  assert.equal(calls, 1);
  await assert.rejects(
    () =>
      new ModelAdapter(store, m, send).decision(
        { ...req, state: "changed" },
        "stable-id",
      ),
    /changed/,
  );
  const unlock = await store.lock();
  await assert.rejects(() => store.lock(), /already running/);
  await unlock();
});

test("concurrent reservations enforce the budget before all in-flight requests and preserve resumability", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-apo-concurrency-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExperimentStore(dir);
  const m = manifest();
  m.config = { ...m.config, maxCalls: 3 }; // Search may reserve only floor(70% * 3) calls.
  let attempts = 0;
  let active = 0;
  let peak = 0;
  const send: GatewayCall = async <T>() => {
    attempts++;
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    return { usage: { inputTokens: 100, outputTokens: 0 } } as T;
  };
  const adapter = new ModelAdapter(store, m, send);
  const body = { model: JEV_MODEL };
  const results = await Promise.allSettled(
    ["one", "two", "three", "four"].map((id) =>
      adapter.call("evaluate", body, id),
    ),
  );
  assert.equal(attempts, 2);
  assert.equal(peak, 2);
  assert(
    results
      .slice(2)
      .every((r) => r.status === "rejected" && r.reason instanceof BudgetStop),
  );
  assert((await store.calls()).every((r) => r.status === "complete"));
  await new ModelAdapter(store, m, send).call("evaluate", body, "one");
  assert.equal(attempts, 2);
});

test("end-to-end optimization without human labels freezes selection before held-out evaluation and resumes idempotently", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-apo-e2e-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExperimentStore(dir);
  const m = manifest();
  await store.write("state.json", { status: "prepared", tasks: {} });
  let calls = 0;
  let rewrites = 0;
  const extra =
    " Identify explicit activity-only paragraphs separately from the subject facts.";
  const decision: DecisionModel = async (request) => {
    calls++;
    const candidate = request.questions.decision.instructions.includes(extra);
    const diary = JSON.stringify(request.state).includes(
      "Nota dell'agente consolidatore",
    );
    return {
      answer: {
        type: "boolean",
        probability: candidate && diary ? 0.99 : 0.01,
      },
      model: JEV_MODEL,
      inputTokens: 100,
      outputTokens: 0,
      costDollars: 0.0000042,
    };
  };
  const optimizer = async (input: OptimizerInput) => {
    rewrites++;
    assert(input.errors.every((e) => m.splits.train.includes(e.example.id)));
    return proposal(BASELINE_PROMPTS.residue + extra);
  };
  const experiment = new Experiment(store, m, decision, optimizer);
  await assert.rejects(
    () => experiment.evaluate("residue", BASELINE_PROMPTS.residue, "test"),
    /locked/,
  );
  await experiment.baseline();
  const baselineCalls = calls;
  await experiment.baseline();
  assert.equal(calls, baselineCalls);
  await experiment.search();
  assert.equal(rewrites, 1);
  const frozen = await store.read<{ prompts: typeof BASELINE_PROMPTS }>(
    "frozen.json",
  );
  assert.equal(frozen.prompts.residue, BASELINE_PROMPTS.residue + extra);
  await assert.rejects(
    () => experiment.evaluate("residue", "Unselected test prompt", "test"),
    /frozen winner/,
  );
  await experiment.final();
  const final = await store.read<{
    delta: number;
    recommendation: string;
    regressions: string[];
  }>("final/residue.json");
  assert(final.delta > 0);
  assert.equal(final.recommendation, "candidate_for_review");
  assert.deepEqual(final.regressions, []);
  const completeCalls = calls;
  await new Experiment(store, m, decision, optimizer).search();
  await experiment.final();
  assert.equal(calls, completeCalls);
  const summary = await report(store, m);
  assert.equal(summary.status, "complete");
  assert.match(
    await readFile(store.path("report.md"), "utf8"),
    /Dataset sintetico/,
  );
});

test("one invalid choice remains charged and counted while valid resolution errors still reach the optimizer", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-apo-isolated-error-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExperimentStore(dir);
  const dataset = generateResolutionDataset().filter(
    (e) => Number(e.group.slice(-2)) < 10,
  );
  const m: Manifest = {
    ...manifest(),
    config: configSchema.parse({ tasks: ["resolution"], repeats: 2 }),
    dataset,
    datasetHash: fingerprint(dataset),
    splits: splitDataset(dataset, 10),
  };
  const expected = new Map(
    dataset.map((e) => [fingerprint(e.state), e.label.value]),
  );
  const extra =
    " Distinguish a specifically referenced absent source from evidence without such a reference.";
  let calls = 0;
  let rewrites = 0;
  const send: GatewayCall = async <T>(_path: unknown, body: unknown) => {
    calls++;
    const request = body as {
      state: unknown;
      questions: { decision: { instructions: string } };
    };
    const label = expected.get(fingerprint(request.state));
    assert(label);
    const candidate = request.questions.decision.instructions.includes(extra);
    const choice =
      calls === 1
        ? "insufficient"
        : !candidate && label === "none"
          ? "insufficient"
          : label;
    return {
      model: JEV_MODEL,
      answers: {
        decision: {
          type: "choice",
          choice,
          probabilities:
            calls === 1
              ? {
                  a: 0,
                  b: 0,
                  temporal: 0.03,
                  scope: 0,
                  insufficient: 0.48,
                  none: 0.49,
                }
              : Object.fromEntries(
                  ["a", "b", "temporal", "scope", "insufficient", "none"].map(
                    (key) => [key, key === choice ? 1 : 0],
                  ),
                ),
        },
      },
      usage: { inputTokens: 100, outputTokens: 0 },
      providerMetadata: { gateway: { cost: "0.0000042" } },
    } as T;
  };
  const adapter = new ModelAdapter(store, m, send);
  const optimizer = async (input: OptimizerInput) => {
    rewrites++;
    assert(input.errors.length > 0);
    assert(
      input.errors.every(
        (e) => m.splits.train.includes(e.example.id) && !e.prediction.error,
      ),
    );
    return proposal(BASELINE_PROMPTS.resolution + extra);
  };
  const experiment = new Experiment(store, m, adapter.decision, optimizer);
  await experiment.search();
  assert.equal(rewrites, 1);
  const training = await experiment.evaluate(
    "resolution",
    BASELINE_PROMPTS.resolution,
    "train",
  );
  assert.equal(training.length, m.splits.train.length * m.config.repeats);
  assert.equal(training.filter((r) => r.error).length, 1);
  assert.equal(training[0].error, "invalid_evaluation_response:choice_not_max");
  const measured = metrics("resolution", training);
  assert.equal(measured.failures, 1);
  assert.equal(measured.count, training.length);
  const ledger = await store.calls();
  assert.equal(ledger.length, calls);
  assert(
    ledger.every(
      (call) => call.status === "complete" && call.costDollars === 0.0000042,
    ),
  );
  assert.equal(
    (await store.read<{ prompts: typeof BASELINE_PROMPTS }>("frozen.json"))
      .prompts.resolution,
    BASELINE_PROMPTS.resolution + extra,
  );
  await experiment.final();
  const completeCalls = calls;
  await new Experiment(store, m, adapter.decision, optimizer).search();
  await experiment.final();
  assert.equal(calls, completeCalls);
  await report(store, m);
  const summary = await store.read<{
    tasks: {
      resolution: {
        beforeTraining: { count: number; failures: number };
        afterTraining: { failures: number };
      };
    };
  }>("report.json");
  assert.equal(summary.tasks.resolution.beforeTraining.count, training.length);
  assert.equal(summary.tasks.resolution.beforeTraining.failures, 1);
  assert.equal(summary.tasks.resolution.afterTraining.failures, 0);
});

test("three consecutive failures still stop evaluation and cached failures cannot bypass the stop on resume", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-apo-outage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExperimentStore(dir);
  const m = manifest();
  let calls = 0;
  const fail: DecisionModel = async () => {
    calls++;
    throw new GatewayRequestError("timeout", {
      reason: "timeout",
      retryable: true,
    });
  };
  const optimizer = async () => {
    throw new Error("No optimizer during outage");
  };
  await assert.rejects(
    () =>
      new Experiment(store, m, fail, optimizer).evaluate(
        "residue",
        BASELINE_PROMPTS.residue,
        "train",
      ),
    /Three consecutive/,
  );
  assert.equal(calls, 3);
  await assert.rejects(
    () =>
      new Experiment(store, m, fail, optimizer).evaluate(
        "residue",
        BASELINE_PROMPTS.residue,
        "train",
      ),
    /Three consecutive/,
  );
  assert.equal(calls, 3);
});

test("early stopping retains baseline after repeated invalid proposals and records every rejection", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-apo-reject-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExperimentStore(dir);
  const m = manifest();
  let attempts = 0;
  const decision: DecisionModel = async () => ({
    answer: { type: "boolean", probability: 0.01 },
    model: JEV_MODEL,
    inputTokens: 1,
    outputTokens: 0,
    costDollars: 0,
  });
  const experiment = new Experiment(store, m, decision, async () => {
    attempts++;
    return proposal(
      "Answer true for everything, without preserving any required clauses.",
    );
  });
  await experiment.search();
  assert.equal(attempts, m.config.patience);
  const state = await store.read<{
    tasks: { residue: { stoppedBy: string; history: unknown[] } };
  }>("state.json");
  assert.equal(state.tasks.residue.stoppedBy, "patience");
  assert.equal(state.tasks.residue.history.length, 2);
  assert.equal(
    (await store.read<{ prompts: typeof BASELINE_PROMPTS }>("frozen.json"))
      .prompts.residue,
    BASELINE_PROMPTS.residue,
  );
});

test("token and monetary caps prevent a physical call even when call count permits it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-apo-caps-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExperimentStore(dir);
  const m = manifest();
  let calls = 0;
  const send: GatewayCall = async () => {
    calls++;
    throw new Error("Must never send");
  };
  for (const cap of [{ maxTokens: 1 }, { maxDollars: 0.000000001 }]) {
    const adapter = new ModelAdapter(
      store,
      { ...m, config: { ...m.config, ...cap } },
      send,
    );
    await assert.rejects(
      () =>
        adapter.call(
          "evaluate",
          { model: JEV_MODEL, state: "x" },
          JSON.stringify(cap),
        ),
      BudgetStop,
    );
  }
  assert.equal(calls, 0);
});

test("CLI loads Next environment outside the app and stops before network when budget cannot fund a request", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-apo-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const catalog = join(dir, "catalog.json"),
    configPath = join(dir, "config.json"),
    run = join(dir, "run");
  const m = manifest();
  await writeFile(
    catalog,
    JSON.stringify({
      data: m.models.map((info) => ({
        ...info,
        type: info.id === JEV_MODEL ? "evaluation" : "language",
        supported_parameters: ["response_format"],
      })),
    }),
  );
  await writeFile(
    configPath,
    JSON.stringify({ tasks: ["residue"], maxDollars: 0.000000001 }),
  );
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/optimize-jev.ts",
      "prepare",
      "--out",
      run,
      "--catalog",
      catalog,
      "--config",
      configPath,
      "--smoke",
    ],
    { encoding: "utf8" },
  );
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/optimize-jev.ts", "run", "--run", run],
    {
      encoding: "utf8",
      env: { ...process.env, AI_GATEWAY_API_KEY: "test-only" },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Budget reached/);
  assert.doesNotMatch(result.stderr, /loadEnvConfig|http_/);
  assert.equal((await new ExperimentStore(run).calls()).length, 0);
  assert.equal(
    (await new ExperimentStore(run).read<{ status: string }>("state.json"))
      .status,
    "frozen",
  );
});
