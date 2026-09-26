import assert from "node:assert/strict";
import test from "node:test";
import type { BrainPage } from "../lib/brain/types";
import {
  analystGates,
  DECISION_POLICY,
  DISCOVERY_FLOOR,
  verificationThreshold,
} from "../lib/maintenance/consolidator/decision-policy";
import { materializeDraft } from "../lib/maintenance/consolidator/editor";
import { buildSnapshot } from "../lib/maintenance/consolidator/snapshot";
import {
  type Evaluate,
  type OperationPlan,
  POLICY,
} from "../lib/maintenance/consolidator/types";
import { verifyChangeSet } from "../lib/maintenance/consolidator/verifier";

function page(id: string, markdown: string): BrainPage {
  return {
    id,
    slug: id,
    title: id,
    markdown,
    type: "note",
    summary: "",
    aliases: [],
    tags: [],
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    embeddedAt: null,
    links: [],
    backlinks: [],
  };
}

function verificationFixtures() {
  const snapshot = buildSnapshot([
    page("a", "Ricavo: 450 euro.\n\nFonte: pagina b.\n\nRicavo: 450 euro."),
    page("b", "Il ricavo è 450 euro."),
  ]);
  const removed = snapshot.units.filter((unit) => unit.pageId === "a")[2];
  const plan: OperationPlan = {
    id: "deduplicate",
    kind: "deduplicate",
    findingIds: ["duplicate"],
    targetPageIds: ["a"],
    targetUnitIds: [removed.id],
    evidenceUnitIds: snapshot.units.map((unit) => unit.id),
    readSet: snapshot.pages.map((entry) => ({
      pageId: entry.id,
      version: entry.version,
    })),
    goal: "Elimina il ricavo ripetuto conservando la fonte.",
  };
  const text = materializeDraft(snapshot, plan, {
    noChange: false,
    links: [],
    patches: [
      { pageId: "a", unitId: removed.id, before: removed.text, after: "" },
    ],
  });
  const linkPlan: OperationPlan = {
    ...plan,
    id: "link",
    kind: "add_link",
    findingIds: ["source-reference"],
    targetUnitIds: [],
    link: { sourceId: "a", targetId: "b", type: "references" },
    goal: "Collega la pagina alla fonte citata.",
  };
  const link = materializeDraft(snapshot, linkPlan, {
    noChange: false,
    patches: [],
    links: [{ sourceId: "a", targetId: "b", type: "references", label: "" }],
  });
  return { snapshot, text, link };
}

test("decision thresholds retain their production values and cache identity", () => {
  assert.deepEqual(DECISION_POLICY, {
    id: "consolidator-calibrated-4541df1d389a34d0",
    analyst: { yes: 0.8, no: 0.2, choiceProbability: 0.8 },
    verifier: {
      objective: 0.8,
      integrity: 0.65,
      link: 0.9,
      conduct: 0.8,
      reject: 0.1,
    },
  });
  assert.equal(POLICY.version, DECISION_POLICY.id);
  assert.equal(DISCOVERY_FLOOR, 0.1);
});

test("verification criteria use their own threshold families", () => {
  assert.equal(verificationThreshold("objective"), 0.8);
  for (const id of [
    "preservation_0",
    "summary_quantities_1",
    "keeper",
    "coherence",
  ])
    assert.equal(verificationThreshold(id), 0.65);
  assert.equal(verificationThreshold("link_target_identity_0"), 0.9);
  assert.equal(verificationThreshold("no_human_work"), 0.8);
  assert.equal(verificationThreshold("no_diary"), 0.8);
});

test("analyst probability boundaries are inclusive and ignore concentration without changing answers", () => {
  const { yes, no, choiceProbability } = DECISION_POLICY.analyst;
  assert.equal(analystGates.yes({ type: "boolean", probability: yes }), true);
  assert.equal(
    analystGates.yes({ type: "boolean", probability: yes - 0.001 }),
    false,
  );
  assert.equal(analystGates.no({ type: "boolean", probability: no }), true);
  assert.equal(
    analystGates.no({ type: "boolean", probability: no + 0.001 }),
    false,
  );
  for (const confidence of [0, 1, null]) {
    const answer = {
      type: "choice" as const,
      choice: "same",
      probabilities: {
        same: choiceProbability,
        different: 1 - choiceProbability,
      },
      confidence,
    };
    const original = structuredClone(answer);
    assert.equal(analystGates.certainChoice(answer), "same");
    assert.deepEqual(answer, original);
    assert.equal(
      analystGates.certainChoice({
        ...answer,
        probabilities: {
          same: choiceProbability - 0.001,
          different: 1 - choiceProbability + 0.001,
        },
      }),
      undefined,
    );
  }
});

test("every verifier family enforces its inclusive boundary and rejects a lone failed criterion", async () => {
  const { snapshot, text, link } = verificationFixtures();
  for (const [family, criterion, changeSet] of [
    ["objective", "objective", text],
    ["integrity", "preservation_0", text],
    ["conduct", "no_human_work", text],
    ["link", "link_direction_0", link],
  ] as const) {
    const threshold = DECISION_POLICY.verifier[family];
    for (const [probability, status] of [
      [threshold, "accepted"],
      [threshold - 0.001, "uncertain"],
      [DECISION_POLICY.verifier.reject + 0.001, "uncertain"],
      [DECISION_POLICY.verifier.reject, "rejected"],
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
      const verification = await verifyChangeSet(snapshot, changeSet, evaluate);
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
