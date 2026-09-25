import assert from "node:assert/strict";
import test from "node:test";
import frozenProfile from "../docs/consolidator-calibration-profile-2026-09-25.json";
import { analyzeTask } from "../lib/maintenance/consolidator/analysis";
import {
  analystGates,
  DEFAULT_DECISION_POLICY,
  type DecisionPolicy,
  DISCOVERY_FLOOR,
  SEED_DECISION_POLICY,
  validateDecisionPolicy,
  verificationFamily,
  verificationThreshold,
} from "../lib/maintenance/consolidator/decision-policy";
import { materializeDraft } from "../lib/maintenance/consolidator/editor";
import { createAnalysisTasks } from "../lib/maintenance/consolidator/snapshot";
import { type Evaluate, POLICY } from "../lib/maintenance/consolidator/types";
import { verifyChangeSet } from "../lib/maintenance/consolidator/verifier";
import { calibrationCases } from "./helpers/consolidation-calibration-cases";

test("probability and optional concentration gates remain distinct and preserve raw answers", () => {
  const answer = {
    type: "choice" as const,
    choice: "same",
    probabilities: { same: 0.86, different: 0.07, insufficient: 0.07 },
    confidence: 0.75,
  };
  const original = structuredClone(answer);
  const policy = {
    ...SEED_DECISION_POLICY,
    analyst: {
      yes: 0.8,
      no: 0.2,
      choiceProbability: 0.8,
      choiceConfidence: null,
    },
  };
  assert.equal(
    analystGates(SEED_DECISION_POLICY).certainChoice(answer),
    undefined,
  );
  assert.equal(analystGates(policy).certainChoice(answer), "same");
  assert.equal(
    analystGates(policy).yes({ type: "boolean", probability: 0.79 }),
    false,
  );
  assert.equal(
    analystGates(policy).no({ type: "boolean", probability: 0.21 }),
    false,
  );
  assert.deepEqual(answer, original);
  assert.equal(DISCOVERY_FLOOR, 0.1);
});

test("verification threshold families do not let objective or link scores compensate for lost knowledge", () => {
  const policy = {
    ...SEED_DECISION_POLICY,
    verifier: {
      objective: 0.7,
      integrity: 0.9,
      link: 0.8,
      conduct: 0.95,
      reject: 0.1,
    },
  };
  assert.equal(verificationThreshold("objective", policy), 0.7);
  for (const id of [
    "preservation_0",
    "summary_quantities_1",
    "keeper",
    "coherence",
    "future_rule",
  ])
    assert.equal(verificationThreshold(id, policy), 0.9);
  assert.equal(verificationThreshold("link_target_identity_0", policy), 0.8);
  assert.equal(verificationThreshold("no_human_work", policy), 0.95);
  assert.equal(verificationFamily("no_diary"), "conduct");
});

test("invalid calibrated profiles cannot overlap or contain non-probabilities", () => {
  assert.deepEqual(
    validateDecisionPolicy(SEED_DECISION_POLICY),
    SEED_DECISION_POLICY,
  );
  assert.throws(() =>
    validateDecisionPolicy({
      ...SEED_DECISION_POLICY,
      analyst: { ...SEED_DECISION_POLICY.analyst, yes: Number.NaN },
    }),
  );
  assert.throws(() =>
    validateDecisionPolicy({
      ...SEED_DECISION_POLICY,
      analyst: { ...SEED_DECISION_POLICY.analyst, yes: 0.1 },
    }),
  );
  assert.throws(() =>
    validateDecisionPolicy({
      ...SEED_DECISION_POLICY,
      verifier: { ...SEED_DECISION_POLICY.verifier, integrity: 0.1 },
    }),
  );
});

function malformedPolicies(): unknown[] {
  const seed = SEED_DECISION_POLICY;
  const invalid: unknown[] = [
    null,
    undefined,
    [],
    {},
    { ...seed, id: " " },
    { ...seed, analyst: null },
    { ...seed, verifier: {} },
    { ...seed, verifier: [] },
    { ...seed, obsoleteThreshold: 0.5 },
  ];
  for (const section of ["analyst", "verifier"] as const) {
    for (const field of Object.keys(seed[section])) {
      const missing = { ...seed[section] } as Record<string, unknown>;
      delete missing[field];
      invalid.push({ ...seed, [section]: missing });
      for (const value of [
        undefined,
        "0.9",
        Number.NaN,
        Number.POSITIVE_INFINITY,
        -0.1,
        1.1,
        false,
        {},
        ...(field === "choiceConfidence" ? [] : [null]),
      ]) {
        invalid.push({
          ...seed,
          [section]: { ...seed[section], [field]: value },
        });
      }
    }
  }
  return invalid;
}

test("policy validation requires every numeric field and permits null only for optional concentration", () => {
  for (const invalid of malformedPolicies()) {
    assert.throws(
      () => validateDecisionPolicy(invalid as DecisionPolicy),
      /Invalid/,
    );
  }
  const valid = {
    ...SEED_DECISION_POLICY,
    analyst: { ...SEED_DECISION_POLICY.analyst, choiceConfidence: null },
  };
  assert.equal(validateDecisionPolicy(valid), valid);
});

test("analysis and verifier reject malformed policies before consulting the model", async () => {
  const fixture = calibrationCases()[0];
  const task = createAnalysisTasks(fixture.snapshot)[0];
  const changeSet = materializeDraft(
    fixture.snapshot,
    fixture.plan,
    fixture.draft,
  );
  let calls = 0;
  const evaluate: Evaluate = async () => {
    calls++;
    throw new Error("The provider must not run under a malformed policy.");
  };
  for (const policy of malformedPolicies()) {
    // Undefined is the documented default parameter, not an injected profile.
    if (policy === undefined) continue;
    await assert.rejects(
      analyzeTask(fixture.snapshot, task, evaluate, policy as DecisionPolicy),
      /Invalid/,
    );
    await assert.rejects(
      verifyChangeSet(
        fixture.snapshot,
        changeSet,
        evaluate,
        policy as DecisionPolicy,
      ),
      /Invalid/,
    );
  }
  assert.equal(calls, 0);
});

test("runtime default exactly matches the frozen calibrated policy and cache identity", () => {
  assert.deepEqual(DEFAULT_DECISION_POLICY, frozenProfile.policy);
  assert.equal(POLICY.version, frozenProfile.policy.id);
  assert.equal(
    validateDecisionPolicy(DEFAULT_DECISION_POLICY),
    DEFAULT_DECISION_POLICY,
  );
});

test("calibrated analyst boundaries use the configured probability bands without an implicit concentration gate", () => {
  const gates = analystGates(DEFAULT_DECISION_POLICY);
  const { yes, no, choiceProbability } = DEFAULT_DECISION_POLICY.analyst;
  assert.equal(gates.yes({ type: "boolean", probability: yes }), true);
  assert.equal(gates.yes({ type: "boolean", probability: yes - 0.001 }), false);
  assert.equal(gates.no({ type: "boolean", probability: no }), true);
  assert.equal(gates.no({ type: "boolean", probability: no + 0.001 }), false);
  const choice = (probability: number) => ({
    type: "choice" as const,
    choice: "same",
    probabilities: { same: probability, different: 1 - probability },
    confidence: 0,
  });
  assert.equal(gates.certainChoice(choice(choiceProbability)), "same");
  assert.equal(
    gates.certainChoice(choice(choiceProbability - 0.001)),
    undefined,
  );
});

test("every calibrated verifier family enforces its own inclusive boundary and rejects a lone failed criterion", async () => {
  const fixtures = calibrationCases();
  const text = fixtures.find(
    (entry) => entry.id === "calibration-irrigation-exception-safe",
  );
  const link = fixtures.find(
    (entry) => entry.id === "calibration-namesake-employer-safe",
  );
  assert.ok(text);
  assert.ok(link);
  for (const [family, criterion, fixture] of [
    ["objective", "objective", text],
    ["integrity", "preservation_0", text],
    ["conduct", "no_human_work", text],
    ["link", "link_direction_0", link],
  ] as const) {
    const threshold = DEFAULT_DECISION_POLICY.verifier[family];
    const changeSet = materializeDraft(
      fixture.snapshot,
      fixture.plan,
      fixture.draft,
    );
    for (const [probability, status] of [
      [threshold, "accepted"],
      [threshold - 0.001, "uncertain"],
      [DEFAULT_DECISION_POLICY.verifier.reject, "rejected"],
    ] as const) {
      let criterionObserved = false;
      const evaluate: Evaluate = async (request) => ({
        model: "typesafe-ai/jev",
        inputTokens: 1,
        outputTokens: 1,
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => {
            if (id === criterion) criterionObserved = true;
            return [
              id,
              {
                type: "boolean" as const,
                probability: id === criterion ? probability : 1,
              },
            ];
          }),
        ),
      });
      // Exercise the production default path, not an explicitly injected test policy.
      const verification = await verifyChangeSet(
        fixture.snapshot,
        changeSet,
        evaluate,
      );
      assert.ok(
        criterionObserved,
        `${family}: the targeted criterion must be evaluated`,
      );
      assert.equal(verification.status, status, `${family} at ${probability}`);
      if (status !== "accepted")
        assert.equal(
          verification.defects.length,
          1,
          `${family}: no high score may offset the failed criterion`,
        );
    }
  }
});
