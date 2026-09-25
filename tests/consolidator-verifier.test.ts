import assert from "node:assert/strict";
import test from "node:test";
import type { BrainPage } from "../lib/brain/types";
import { materializeDraft } from "../lib/maintenance/consolidator/editor";
import { buildSnapshot } from "../lib/maintenance/consolidator/snapshot";
import type {
  Evaluate,
  EvaluationRequest,
  OperationPlan,
} from "../lib/maintenance/consolidator/types";
import { verifyChangeSet } from "../lib/maintenance/consolidator/verifier";

function fixture() {
  const page: BrainPage = {
    id: "a",
    slug: "a",
    title: "Ricavi",
    markdown:
      "Ricavo: 450 euro.\n\nIl dato vale solo per l'Italia, escluse le imposte.\n\nRicavo: 450 euro.",
    type: "note",
    summary: "Ricavi italiani",
    aliases: [],
    tags: [],
    version: 2,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    embeddedAt: null,
    links: [],
    backlinks: [],
  };
  const snapshot = buildSnapshot([page]);
  const removed = snapshot.units[2];
  const plan: OperationPlan = {
    id: "operation",
    kind: "deduplicate",
    findingIds: ["finding"],
    targetPageIds: ["a"],
    targetUnitIds: [removed.id],
    evidenceUnitIds: [snapshot.units[0].id, removed.id],
    readSet: [{ pageId: "a", version: 2 }],
    goal: "Elimina il ricavo ripetuto senza perdere condizioni ed eccezioni.",
  };
  const changeSet = materializeDraft(snapshot, plan, {
    noChange: false,
    links: [],
    patches: [
      { pageId: "a", unitId: removed.id, before: removed.text, after: "" },
    ],
  });
  return { snapshot, plan, changeSet };
}

function evaluator(
  score: (id: string, request: EvaluationRequest) => number = () => 1,
): Evaluate {
  return async (request) => ({
    answers: Object.fromEntries(
      Object.keys(request.questions).map((id) => [
        id,
        { type: "boolean" as const, probability: score(id, request) },
      ]),
    ),
    model: "typesafe-ai/jev",
    inputTokens: 1,
    outputTokens: 1,
  });
}

test("verifies all original and final units with separate qualifiers and without analyst scores", async () => {
  const { snapshot, changeSet } = fixture();
  const requests: EvaluationRequest[] = [];
  const result = await verifyChangeSet(snapshot, changeSet, async (request) => {
    requests.push(request);
    return evaluator()(request);
  });
  assert.equal(result.status, "accepted");
  const questions = Object.assign(
    {},
    ...requests.map((request) => request.questions),
  );
  assert.equal(
    Object.keys(questions).filter((id) => id.startsWith("preservation_"))
      .length,
    3,
  );
  for (const dimension of [
    "support",
    "provenance",
    "time",
    "scope",
    "conditions",
    "exceptions",
    "negations",
    "quantities",
    "certainty",
  ]) {
    assert.equal(
      Object.keys(questions).filter((id) => id.startsWith(`${dimension}_`))
        .length,
      2,
    );
  }
  const state = requests[0].state as {
    originalUnits: { id: string }[];
    operation: Record<string, unknown>;
  };
  assert.ok(
    state.originalUnits.some((unit) => unit.id === snapshot.units[1].id),
  );
  assert.equal(state.operation.findingIds, undefined);
  assert.equal(state.operation.judgments, undefined);
  assert.match(
    questions.preservation_1.instructions,
    /even if operation.evidenceUnitIds did not select/,
  );
});

test("one failed preservation or qualifier rejects the whole result regardless of other scores", async () => {
  for (const criterion of [
    "preservation_1",
    "provenance_0",
    "time_0",
    "scope_0",
    "conditions_0",
    "exceptions_0",
    "negations_0",
    "quantities_0",
    "certainty_0",
    "objective",
    "no_human_work",
    "no_diary",
  ]) {
    const { snapshot, changeSet } = fixture();
    const result = await verifyChangeSet(
      snapshot,
      changeSet,
      evaluator((id) => (id === criterion ? 0 : 1)),
    );
    assert.equal(result.status, "rejected", criterion);
    assert.ok(result.defects.length > 0);
  }
});

test("missing, unknown, malformed and uncertain judgments fail closed", async () => {
  const { snapshot, changeSet } = fixture();
  const missing: Evaluate = async (request) => {
    const response = await evaluator()(request);
    delete response.answers.objective;
    return response;
  };
  const unknown: Evaluate = async (request) => {
    const response = await evaluator()(request);
    response.answers.unrequested = { type: "boolean", probability: 1 };
    return response;
  };
  for (const evaluate of [
    missing,
    unknown,
    evaluator((id) => (id === "objective" ? Number.NaN : 1)),
    evaluator((id) => (id === "objective" ? 0.6 : 1)),
  ]) {
    assert.equal(
      (await verifyChangeSet(snapshot, changeSet, evaluate)).status,
      "uncertain",
    );
  }
});

test("does not make semantic calls when the draft makes no change", async () => {
  const { snapshot, plan } = fixture();
  const changeSet = materializeDraft(snapshot, plan, {
    patches: [],
    links: [],
    noChange: true,
  });
  const result = await verifyChangeSet(snapshot, changeSet, async () => {
    throw new Error("Must not evaluate an unchanged result");
  });
  assert.equal(result.status, "rejected");
  assert.deepEqual(result.judgments, []);
});

test("correction exemptions remain explicit, localized and evidence-bound", async () => {
  const { snapshot, plan } = fixture();
  const target = snapshot.units[0];
  const correctionPlan: OperationPlan = {
    ...plan,
    kind: "reconcile",
    resolution: "b",
    targetUnitIds: [target.id],
    correctionUnitIds: [target.id],
    goal: "Correggi 450 in 4500 come stabilito dalla fonte.",
  };
  const changeSet = materializeDraft(snapshot, correctionPlan, {
    noChange: false,
    links: [],
    patches: [
      {
        pageId: "a",
        unitId: target.id,
        before: target.text,
        after: target.text.replace("450", "4500"),
      },
    ],
  });
  const result = await verifyChangeSet(snapshot, changeSet, async (request) => {
    const state = request.state as {
      operation: { correctionUnitIds: string[] };
    };
    assert.deepEqual(state.operation.correctionUnitIds, [target.id]);
    assert.match(
      request.questions.preservation_0.instructions,
      /this exact unit ID is in operation.correctionUnitIds/,
    );
    assert.match(
      request.questions.preservation_0.instructions,
      /never authorizes deleting its other distinct facts/,
    );
    // The fixture has no supporting source for 4500: an exemption alone cannot pass.
    return evaluator((id) => (id === "support_0" ? 0 : 1))(request);
  });
  assert.equal(result.status, "rejected");
  assert.throws(
    () =>
      materializeDraft(
        snapshot,
        { ...correctionPlan, correctionUnitIds: [snapshot.units[1].id] },
        changeSet.draft,
      ),
    /unbounded correction/,
  );
});

test("provider transport failures remain technical errors rather than negative semantic judgments", async () => {
  const { snapshot, changeSet } = fixture();
  await assert.rejects(
    verifyChangeSet(snapshot, changeSet, async () => {
      throw new Error("transport unavailable");
    }),
    /transport unavailable/,
  );
});

test("typed links require separate identity, relation and direction judgments", async () => {
  const { snapshot: original, plan } = fixture();
  const snapshot = buildSnapshot([
    ...original.pages,
    {
      ...original.pages[0],
      id: "b",
      slug: "b",
      title: "Fonte ricavi",
      markdown: "La pagina ricavi fa riferimento a questa fonte.",
    },
  ]);
  const linkPlan: OperationPlan = {
    ...plan,
    kind: "add_link",
    link: { sourceId: "a", targetId: "b", type: "references" },
    readSet: snapshot.pages.map((page) => ({
      pageId: page.id,
      version: page.version,
    })),
  };
  const changeSet = materializeDraft(snapshot, linkPlan, {
    noChange: false,
    patches: [],
    links: [{ sourceId: "a", targetId: "b", type: "references", label: "" }],
  });
  const evaluated = new Set<string>();
  const result = await verifyChangeSet(
    snapshot,
    changeSet,
    evaluator((id) => {
      evaluated.add(id);
      return id === "link_direction_0" ? 0 : 1;
    }),
  );
  assert.equal(result.status, "rejected");
  for (const criterion of [
    "source_identity",
    "target_identity",
    "relation",
    "direction",
  ])
    assert.ok(evaluated.has(`link_${criterion}_0`));
});

test("oversized final contexts remain uncertain without dropping units or making partial evaluations", async () => {
  const { snapshot: original, plan } = fixture();
  const snapshot = buildSnapshot([
    {
      ...original.pages[0],
      markdown: "Dettaglio distinto e importante. ".repeat(1700),
    },
  ]);
  const unit = snapshot.units[0];
  const longPlan = {
    ...plan,
    targetUnitIds: [unit.id],
    evidenceUnitIds: [unit.id],
  };
  const changeSet = materializeDraft(snapshot, longPlan, {
    noChange: false,
    links: [],
    patches: [
      {
        pageId: "a",
        unitId: unit.id,
        before: unit.text,
        after: "Dettaglio distinto e importante. ",
      },
    ],
  });
  const result = await verifyChangeSet(snapshot, changeSet, async () => {
    throw new Error("Oversized inputs must not be evaluated partially");
  });
  assert.equal(result.status, "uncertain");
  assert.equal(result.incomplete, true);
  assert.match(result.defects[0], /capacity/);
  assert.deepEqual(result.judgments, []);
});

test("keeper judgment checks the selected survivor's distinct facts at its final location", async () => {
  const { snapshot, plan } = fixture();
  const keeper = snapshot.units[0];
  const removed = snapshot.units[2];
  const keeperPlan = {
    ...plan,
    retainedUnitId: keeper.id,
    targetUnitIds: [removed.id, keeper.id],
  };
  const changeSet = materializeDraft(snapshot, keeperPlan, {
    noChange: false,
    links: [],
    patches: [
      { pageId: "a", unitId: removed.id, before: removed.text, after: "" },
    ],
  });
  const result = await verifyChangeSet(snapshot, changeSet, async (request) => {
    const state = request.state as {
      operation: { retainedUnitId: string; targetUnitIds: string[] };
    };
    assert.equal(state.operation.retainedUnitId, keeper.id);
    assert.deepEqual(state.operation.targetUnitIds, [removed.id, keeper.id]);
    assert.match(
      request.questions.keeper.instructions,
      /final resultPages page a/,
    );
    assert.match(
      request.questions.keeper.instructions,
      /survivor's own distinct details/,
    );
    return evaluator((id) => (id === "keeper" ? 0 : 1))(request);
  });
  assert.equal(result.status, "rejected");
  assert.ok(result.defects.some((defect) => defect.includes("keeper:")));
});

test("model evidence excludes backlinks and joined titles while original materialization stays intact", async () => {
  const { snapshot, plan, changeSet: initial } = fixture();
  snapshot.pages[0].links = [
    {
      id: "outgoing",
      sourceId: "a",
      targetId: "outside",
      type: "references",
      label: "Versioned outgoing label",
      targetTitle: "UNVERSIONED_TARGET_TITLE",
      targetSlug: "UNVERSIONED_TARGET_SLUG",
      sourceTitle: "UNVERSIONED_SOURCE_TITLE",
      sourceSlug: "UNVERSIONED_SOURCE_SLUG",
    },
  ];
  snapshot.pages[0].backlinks = [
    {
      id: "incoming",
      sourceId: "outside",
      targetId: "a",
      type: "references",
      label: "UNVERSIONED_BACKLINK_LABEL",
    },
  ];
  const changeSet = materializeDraft(snapshot, plan, initial.draft);
  const result = await verifyChangeSet(snapshot, changeSet, async (request) => {
    const state = request.state as {
      originalPages: Record<string, unknown>[];
      resultPages: Record<string, unknown>[];
    };
    for (const page of [...state.originalPages, ...state.resultPages])
      assert.equal(page.backlinks, undefined);
    assert.doesNotMatch(JSON.stringify(request.state), /UNVERSIONED_/);
    assert.match(JSON.stringify(request.state), /Versioned outgoing label/);
    return evaluator()(request);
  });
  assert.equal(result.status, "accepted");
  assert.deepEqual(changeSet.changes[0].after.links, snapshot.pages[0].links);
  assert.deepEqual(
    changeSet.changes[0].after.backlinks,
    snapshot.pages[0].backlinks,
  );
});

test("summary corrections are checked for preservation, support, qualifiers, necessity and final coherence", async () => {
  const { snapshot: initial } = fixture();
  const snapshot = buildSnapshot([
    {
      ...initial.pages[0],
      markdown:
        "Ricavo trascritto: 450 euro.\n\nFonte originale: il ricavo italiano è 4500 euro.",
      summary: "Ricavo italiano: 450 euro.",
    },
  ]);
  const target = snapshot.units[0];
  const plan: OperationPlan = {
    id: "summary-correction",
    kind: "reconcile",
    findingIds: ["correction"],
    targetPageIds: ["a"],
    targetUnitIds: [target.id],
    evidenceUnitIds: snapshot.units.map((unit) => unit.id),
    readSet: [{ pageId: "a", version: 2 }],
    resolution: "b",
    correctionUnitIds: [target.id],
    goal: "Correggi la trascrizione del ricavo da 450 a 4500 euro secondo la fonte.",
  };
  const draft = {
    noChange: false,
    links: [],
    patches: [
      {
        pageId: "a",
        unitId: target.id,
        before: target.text,
        after: "Ricavo italiano: 4500 euro.\n\n",
      },
    ],
    summaryPatches: [
      {
        pageId: "a",
        before: snapshot.pages[0].summary,
        after: "Ricavo italiano: 4500 euro.",
      },
    ],
  };
  const changeSet = materializeDraft(snapshot, plan, draft);
  const checked = new Set<string>();
  const accepted = await verifyChangeSet(
    snapshot,
    changeSet,
    evaluator((id, request) => {
      checked.add(id);
      if (id === "summary_preservation_0")
        assert.match(
          request.questions[id].instructions,
          /same underlying assertion explicitly authorized/,
        );
      return 1;
    }),
  );
  assert.equal(accepted.status, "accepted");
  for (const criterion of [
    "preservation",
    "support",
    "provenance",
    "time",
    "scope",
    "conditions",
    "exceptions",
    "negations",
    "quantities",
    "certainty",
    "coherence",
    "necessity",
  ])
    assert.ok(checked.has(`summary_${criterion}_0`));
  for (const rejectedCriterion of [
    "summary_preservation_0",
    "summary_support_0",
    "summary_necessity_0",
    "summary_coherence_0",
  ])
    assert.equal(
      (
        await verifyChangeSet(
          snapshot,
          changeSet,
          evaluator((id) => (id === rejectedCriterion ? 0 : 1)),
        )
      ).status,
      "rejected",
    );
  const stale = materializeDraft(snapshot, plan, {
    ...draft,
    summaryPatches: [],
  });
  const staleResult = await verifyChangeSet(
    snapshot,
    stale,
    evaluator((id, request) => {
      if (id !== "summary_coherence_0") return 1;
      const state = request.state as {
        resultPages: { markdown: string; summary: string }[];
      };
      assert.match(state.resultPages[0].markdown, /4500/);
      assert.equal(state.resultPages[0].summary, "Ricavo italiano: 450 euro.");
      return 0;
    }),
  );
  assert.equal(staleResult.status, "rejected");
});

test("residue URL exception still requires explicit proof that original subject knowledge and sources are preserved", async () => {
  const { snapshot: initial, plan: initialPlan } = fixture();
  const snapshot = buildSnapshot([
    {
      ...initial.pages[0],
      markdown:
        "Consolidamento completato. Dato unico: 450 euro. [Fonte](https://example.com/source).",
      summary: "",
    },
  ]);
  const unit = snapshot.units[0];
  const plan = {
    ...initialPlan,
    kind: "remove_maintenance_residue" as const,
    targetUnitIds: [unit.id],
    evidenceUnitIds: [unit.id],
  };
  const changeSet = materializeDraft(snapshot, plan, {
    noChange: false,
    links: [],
    patches: [{ pageId: "a", unitId: unit.id, before: unit.text, after: "" }],
  });
  const result = await verifyChangeSet(
    snapshot,
    changeSet,
    evaluator((id, request) => {
      if (id !== "preservation_0") return 1;
      assert.match(
        request.questions[id].instructions,
        /no uniquely useful factual source/,
      );
      assert.match(
        request.questions[id].instructions,
        /residue label alone never authorizes its loss/,
      );
      return 0;
    }),
  );
  assert.equal(result.status, "rejected");
});

test("empty-label link-only edits use exact page proofs and require all six applicable semantic checks", async () => {
  const { snapshot: initial, plan: base } = fixture();
  const snapshot = buildSnapshot([
    { ...initial.pages[0], markdown: "Ada lavora per Beta." },
    {
      ...initial.pages[0],
      id: "b",
      slug: "b",
      title: "Beta",
      markdown: "Beta è l'azienda per cui lavora Ada.",
    },
  ]);
  const plan: OperationPlan = {
    ...base,
    kind: "add_link",
    targetUnitIds: [],
    evidenceUnitIds: snapshot.units.map((unit) => unit.id),
    readSet: snapshot.pages.map((page) => ({
      pageId: page.id,
      version: page.version,
    })),
    link: { sourceId: "a", targetId: "b", type: "works_at" },
    goal: "Aggiungi la relazione di impiego documentata.",
  };
  assert.ok(plan.link);
  const changeSet = materializeDraft(snapshot, plan, {
    noChange: false,
    patches: [],
    links: [{ ...plan.link, label: "" }],
  });
  const expected = [
    "objective",
    "coherence",
    "link_source_identity_0",
    "link_target_identity_0",
    "link_relation_0",
    "link_direction_0",
  ].sort();
  const result = await verifyChangeSet(
    snapshot,
    changeSet,
    evaluator((id, request) => {
      assert.deepEqual(Object.keys(request.questions).sort(), expected);
      const state = request.state as {
        exactInvariance: {
          noNewProse: boolean;
          pages: {
            pageId: string;
            originalContextHash: string;
            resultContextHash: string;
          }[];
        };
      };
      assert.equal(state.exactInvariance.noNewProse, true);
      assert.deepEqual(
        state.exactInvariance.pages.map((proof) => proof.pageId),
        ["a", "b"],
      );
      for (const proof of state.exactInvariance.pages)
        assert.equal(proof.originalContextHash, proof.resultContextHash);
      // An irrelevant prose criterion would veto here if it were still requested.
      return expected.includes(id) ? 1 : 0;
    }),
  );
  assert.equal(result.status, "accepted");
  const uncertainRelation = await verifyChangeSet(
    snapshot,
    changeSet,
    evaluator((id) => (id === "link_relation_0" ? 0.87 : 1)),
  );
  assert.equal(uncertainRelation.status, "uncertain");
  assert.ok(
    uncertainRelation.defects.some((defect) =>
      defect.includes("link:relation:"),
    ),
  );
});

test("a nonempty added link label still requires human-work and diary judgments", async () => {
  const { snapshot: initial, plan: base } = fixture();
  const snapshot = buildSnapshot([
    ...initial.pages,
    { ...initial.pages[0], id: "b", slug: "b", title: "Beta" },
  ]);
  const plan: OperationPlan = {
    ...base,
    kind: "add_link",
    targetUnitIds: [],
    readSet: snapshot.pages.map((page) => ({
      pageId: page.id,
      version: page.version,
    })),
    link: { sourceId: "a", targetId: "b", type: "references" },
  };
  assert.ok(plan.link);
  const changeSet = materializeDraft(snapshot, plan, {
    noChange: false,
    patches: [],
    links: [{ ...plan.link, label: "Chiedere conferma al proprietario" }],
  });
  const result = await verifyChangeSet(
    snapshot,
    changeSet,
    evaluator((id, request) => {
      assert.ok(request.questions.no_human_work);
      assert.ok(request.questions.no_diary);
      return id === "no_human_work" ? 0 : 1;
    }),
  );
  assert.equal(result.status, "rejected");
});

test("unchanged evidence pages are proved, but every unit on an altered page is still judged", async () => {
  const { snapshot: initial, plan: base, changeSet: initialChange } = fixture();
  const snapshot = buildSnapshot([
    ...initial.pages,
    {
      ...initial.pages[0],
      id: "b",
      slug: "b",
      title: "Fonte",
      markdown: "Documento di fonte invariato.",
    },
  ]);
  const plan = {
    ...base,
    readSet: snapshot.pages.map((page) => ({
      pageId: page.id,
      version: page.version,
    })),
  };
  const changeSet = materializeDraft(snapshot, plan, initialChange.draft);
  const seen = new Set<string>();
  const result = await verifyChangeSet(
    snapshot,
    changeSet,
    evaluator((id, request) => {
      seen.add(id);
      const state = request.state as {
        exactInvariance: { pages: { pageId: string }[] };
      };
      assert.deepEqual(
        state.exactInvariance.pages.map((proof) => proof.pageId),
        ["b"],
      );
      return id === "preservation_1" ? 0 : 1;
    }),
  );
  assert.equal(result.status, "rejected");
  for (const id of [
    "preservation_0",
    "preservation_1",
    "preservation_2",
    "support_0",
    "support_1",
    "summary_preservation_0",
    "summary_support_0",
  ])
    assert.ok(seen.has(id), id);
  for (const id of [
    "preservation_3",
    "support_2",
    "summary_preservation_1",
    "summary_support_1",
  ])
    assert.equal(seen.has(id), false, id);
});

test("moving identical text to another page or changing surrounding headings never earns an invariance proof", async () => {
  const { snapshot: initial, plan: base } = fixture();
  const snapshot = buildSnapshot([
    {
      ...initial.pages[0],
      markdown: "# Contesto A\n\nDato distinto importante.",
    },
    {
      ...initial.pages[0],
      id: "b",
      slug: "b",
      title: "Destinazione",
      markdown: "# Contesto B\n\nAltro dato.",
    },
  ]);
  const source = snapshot.units.find(
    (unit) => unit.pageId === "a" && unit.text.includes("Dato distinto"),
  );
  const keeper = snapshot.units.find(
    (unit) => unit.pageId === "b" && unit.text.includes("Altro dato"),
  );
  assert.ok(source && keeper);
  const plan: OperationPlan = {
    ...base,
    kind: "centralize",
    targetPageIds: ["a", "b"],
    targetUnitIds: [source.id, keeper.id],
    evidenceUnitIds: snapshot.units.map((unit) => unit.id),
    readSet: snapshot.pages.map((page) => ({
      pageId: page.id,
      version: page.version,
    })),
    canonicalPageId: "b",
    retainedUnitId: keeper.id,
  };
  const changeSet = materializeDraft(snapshot, plan, {
    noChange: false,
    links: [],
    patches: [
      {
        pageId: "a",
        unitId: source.id,
        before: source.text,
        after: "Vedi [destinazione](/pages/b).",
      },
      {
        pageId: "b",
        unitId: keeper.id,
        before: keeper.text,
        after: `${keeper.text}\n\n${source.text}`,
      },
    ],
  });
  const questions = new Set<string>();
  const result = await verifyChangeSet(
    snapshot,
    changeSet,
    evaluator((id, request) => {
      questions.add(id);
      const state = request.state as {
        exactInvariance: { pages: unknown[] };
        resultUnits: { text: string }[];
      };
      assert.deepEqual(state.exactInvariance.pages, []);
      assert.ok(state.resultUnits.some((unit) => unit.text === source.text));
      return 1;
    }),
  );
  assert.equal(result.status, "accepted");
  assert.equal(
    [...questions].filter((id) => id.startsWith("preservation_")).length,
    snapshot.units.length,
  );
  assert.ok(questions.has("keeper"));
});
