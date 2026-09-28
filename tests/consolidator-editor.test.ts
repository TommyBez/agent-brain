import assert from "node:assert/strict";
import test from "node:test";
import type { BrainPage } from "../lib/brain/types";
import {
  draftChanges,
  materializeDraft,
} from "../lib/maintenance/consolidator/editor";
import { buildSnapshot } from "../lib/maintenance/consolidator/snapshot";
import type {
  Draft,
  OperationPlan,
  Snapshot,
} from "../lib/maintenance/consolidator/types";

function page(id: string, markdown: string): BrainPage {
  return {
    id,
    slug: id,
    title: id,
    markdown,
    type: "note",
    summary: "Original summary",
    aliases: ["alias"],
    tags: ["tag"],
    version: 4,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    embeddedAt: null,
    links: [],
    backlinks: [],
  };
}

function planFor(
  snapshot: Snapshot,
  overrides: Partial<OperationPlan> = {},
): OperationPlan {
  return {
    id: "operation",
    kind: "deduplicate",
    findingIds: ["finding"],
    targetPageIds: [snapshot.pages[0].id],
    targetUnitIds: snapshot.units
      .filter((unit) => unit.pageId === snapshot.pages[0].id)
      .map((unit) => unit.id),
    evidenceUnitIds: snapshot.units.map((unit) => unit.id),
    readSet: snapshot.pages.map((page) => ({
      pageId: page.id,
      version: page.version,
    })),
    goal: "Elimina il duplicato preservando le eccezioni.",
    ...overrides,
  };
}

function replace(snapshot: Snapshot, index: number, after: string): Draft {
  const unit = snapshot.units[index];
  return {
    noChange: false,
    links: [],
    patches: [
      { pageId: unit.pageId, unitId: unit.id, before: unit.text, after },
    ],
  };
}

test("materializes exact bounded edits without mutating snapshots or metadata", () => {
  const snapshot = buildSnapshot([
    page("a", "Disponibile solo in Italia.\n\nDisponibile solo in Italia."),
  ]);
  const original = structuredClone(snapshot);
  const change = materializeDraft(
    snapshot,
    planFor(snapshot),
    replace(snapshot, 1, ""),
  );
  assert.equal(
    change.changes[0].after.markdown,
    "Disponibile solo in Italia.\n\n",
  );
  assert.deepEqual(
    { ...change.changes[0].after, markdown: original.pages[0].markdown },
    original.pages[0],
  );
  assert.deepEqual(snapshot, original);
  assert.equal(
    materializeDraft(snapshot, planFor(snapshot), replace(snapshot, 1, "")).id,
    change.id,
  );
});

test("rejects stale anchors, off-plan patches, overlap, empty and no-op writes", () => {
  const snapshot = buildSnapshot([page("a", "Uno.\n\nDue.")]);
  const plan = planFor(snapshot);
  const draft = replace(snapshot, 0, "Tre.\n\n");
  assert.throws(
    () => materializeDraft(snapshot, { ...plan, targetUnitIds: [] }, draft),
    /outside planned/,
  );
  assert.throws(
    () =>
      materializeDraft(snapshot, plan, {
        ...draft,
        patches: [{ ...draft.patches[0], before: "Uno." }],
      }),
    /exact unit/,
  );
  assert.throws(
    () =>
      materializeDraft(snapshot, plan, {
        ...draft,
        patches: [draft.patches[0], draft.patches[0]],
      }),
    /overlapping/,
  );
  assert.throws(
    () =>
      materializeDraft(
        snapshot,
        plan,
        replace(snapshot, 0, snapshot.units[0].text),
      ),
    /no-op/,
  );
  assert.throws(
    () =>
      materializeDraft(snapshot, plan, {
        noChange: false,
        patches: [],
        links: [],
      }),
    /empty change/,
  );
  assert.throws(
    () => materializeDraft(snapshot, plan, { ...draft, noChange: true }),
    /contains writes/,
  );
  assert.throws(
    () =>
      materializeDraft(
        snapshot,
        { ...plan, readSet: [{ pageId: "a", version: 3 }] },
        draft,
      ),
    /stale read/,
  );
  const overlapping = {
    ...snapshot.units[0],
    id: "overlap",
    start: 1,
    text: snapshot.units[0].text.slice(1),
  };
  const invalidSnapshot = {
    ...snapshot,
    units: [...snapshot.units, overlapping],
  };
  assert.throws(
    () =>
      materializeDraft(
        invalidSnapshot,
        { ...plan, targetUnitIds: [...plan.targetUnitIds, "overlap"] },
        {
          ...draft,
          patches: [
            ...draft.patches,
            {
              pageId: "a",
              unitId: "overlap",
              before: overlapping.text,
              after: "x",
            },
          ],
        },
      ),
    /overlapping patch ranges/,
  );
});

test("preserves sources and URLs; centralization requires a surviving source and destination reference", () => {
  const snapshot = buildSnapshot([
    page("a", "Ricavo: 450 euro. [Fonte](https://example.com/report)."),
    page("b", "Ricavo: 450 euro."),
  ]);
  assert.throws(
    () =>
      materializeDraft(
        snapshot,
        planFor(snapshot),
        replace(snapshot, 0, "Ricavo: 450 euro."),
      ),
    /source or URL removed/,
  );
  const plan = planFor(snapshot, {
    kind: "centralize",
    targetPageIds: ["a", "b"],
    targetUnitIds: snapshot.units.map((unit) => unit.id),
    canonicalPageId: "b",
  });
  const draft = replace(snapshot, 0, "Vedi [ricavo](/pages/b).");
  draft.patches.push({
    pageId: "b",
    unitId: snapshot.units[1].id,
    before: snapshot.units[1].text,
    after: snapshot.units[0].text,
  });
  const changes = materializeDraft(snapshot, plan, draft).changes;
  assert.match(changes[1].after.markdown, /https:\/\/example.com\/report/);
  assert.throws(
    () =>
      materializeDraft(snapshot, plan, {
        ...draft,
        patches: [{ ...draft.patches[0], after: "Ricavo." }, draft.patches[1]],
      }),
    /source or URL removed/,
  );
});

test("rejects invented destinations, fragment anchors, references and external URLs", () => {
  const snapshot = buildSnapshot([
    page("a", "Informazione."),
    page("b", "# Titolo\nContenuto."),
  ]);
  for (const after of [
    "Vedi [pagina](/pages/missing).",
    "Vedi [titolo](/pages/b#titolo).",
    "Vedi [fonte][missing].",
    "Vedi [fonte](https://invented.example/source).",
  ]) {
    assert.throws(
      () =>
        materializeDraft(
          snapshot,
          planFor(snapshot),
          replace(snapshot, 0, after),
        ),
      /link target|anchor|undefined Markdown|new URL/,
    );
  }
});

test("preserves URLs containing balanced parentheses across Markdown forms", () => {
  const snapshot = buildSnapshot([
    page("a", "Ricavo. [Fonte](https://example.com/report(2026))."),
  ]);
  const result = materializeDraft(
    snapshot,
    planFor(snapshot),
    replace(snapshot, 0, "Ricavo. Fonte: https://example.com/report(2026)."),
  );
  assert.match(result.changes[0].after.markdown, /report\(2026\)/);
});

test("existing literal percent signs in links do not block unrelated edits", () => {
  const snapshot = buildSnapshot([
    page("a", "[Report](/pages/growth-100%).\n\nFatto.\n\nFatto."),
  ]);
  const result = materializeDraft(
    snapshot,
    planFor(snapshot),
    replace(snapshot, 2, ""),
  );
  assert.equal(
    result.changes[0].after.markdown,
    "[Report](/pages/growth-100%).\n\nFatto.\n\n",
  );
});

test("encoded local links resolve their targets and unknown targets still fail", () => {
  const snapshot = buildSnapshot([
    page("a", "Informazione."),
    page("b", "Destinazione."),
  ]);
  const result = materializeDraft(
    snapshot,
    planFor(snapshot),
    replace(snapshot, 0, "Informazione. Vedi [pagina](/pages/%62)."),
  );
  assert.match(result.changes[0].after.markdown, /\/pages\/%62/);
  for (const path of ["/pages/%6dissing", "/pages/growth-100%"])
    assert.throws(
      () =>
        materializeDraft(
          snapshot,
          planFor(snapshot),
          replace(snapshot, 0, `Informazione. Vedi [pagina](${path}).`),
        ),
      /unknown local link target/,
    );
});

test("constructs only planned typed links without calling a provider", async (t) => {
  const snapshot = buildSnapshot([
    page("a", "Anna lavora per Beta."),
    page("b", "Beta è un'azienda."),
  ]);
  const plan = planFor(snapshot, {
    kind: "add_link",
    link: { sourceId: "a", targetId: "b", type: "works_at" },
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected provider call");
  });
  const draft = await draftChanges(snapshot, plan);
  const changeSet = materializeDraft(snapshot, plan, draft);
  assert.deepEqual(draft.links, [
    { sourceId: "a", targetId: "b", type: "works_at", label: "" },
  ]);
  assert.equal(changeSet.changes[0].after.version, 4);
  assert.throws(
    () =>
      materializeDraft(snapshot, plan, {
        ...draft,
        links: [{ ...draft.links[0], type: "owns" }],
      }),
    /unplanned link/,
  );
});

test("DeepSeek receives strict JSON schema, complete scoped sources and no write tools", async (t) => {
  const source = page("a", "Un fatto.\n\nUn fatto.");
  source.links = [
    {
      id: "existing",
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
  source.backlinks = [
    {
      id: "incoming",
      sourceId: "outside",
      targetId: "a",
      type: "references",
      label: "UNVERSIONED_BACKLINK_LABEL",
    },
  ];
  const snapshot = buildSnapshot([source]);
  const plan = planFor(snapshot);
  const draft = { ...replace(snapshot, 1, ""), summaryPatches: [] };
  const previousKey = process.env.AI_GATEWAY_API_KEY;
  const previousModel = process.env.CONSOLIDATION_MODEL;
  process.env.AI_GATEWAY_API_KEY = "test-only";
  delete process.env.CONSOLIDATION_MODEL;
  t.after(() => {
    if (previousKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.CONSOLIDATION_MODEL;
    else process.env.CONSOLIDATION_MODEL = previousModel;
  });
  let responseContent = JSON.stringify(draft);
  let expectedModel = "deepseek/deepseek-v4.1-flash";
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(
        String(url),
        "https://ai-gateway.vercel.sh/v1/chat/completions",
      );
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, expectedModel);
      assert.equal(body.response_format.json_schema.strict, true);
      assert.equal(
        body.response_format.json_schema.schema.additionalProperties,
        false,
      );
      assert.equal(body.tools, undefined);
      const userContent = body.messages.find(
        (message: { role: string }) => message.role === "user",
      ).content;
      const evidencePage = JSON.parse(userContent).pages[0];
      assert.equal(evidencePage.markdown, snapshot.pages[0].markdown);
      assert.equal(evidencePage.backlinks, undefined);
      assert.equal(evidencePage.links[0].label, "Versioned outgoing label");
      assert.equal(evidencePage.links[0].targetId, "outside");
      assert.doesNotMatch(userContent, /UNVERSIONED_/);
      assert.equal(
        snapshot.pages[0].backlinks[0].label,
        "UNVERSIONED_BACKLINK_LABEL",
      );
      return Response.json({
        choices: [
          { finish_reason: "stop", message: { content: responseContent } },
        ],
      });
    },
  );
  assert.deepEqual(
    await draftChanges(snapshot, plan, ["Preserva le eccezioni."]),
    draft,
  );
  process.env.CONSOLIDATION_MODEL = "test/configured-editor";
  expectedModel = "test/configured-editor";
  assert.deepEqual(await draftChanges(snapshot, plan), draft);
  process.env.CONSOLIDATION_MODEL = "";
  expectedModel = "deepseek/deepseek-v4.1-flash";
  assert.deepEqual(await draftChanges(snapshot, plan), draft);
  const invalidAnchor = {
    ...draft,
    patches: [{ ...draft.patches[0], before: "Incorrect original text" }],
  };
  responseContent = JSON.stringify(invalidAnchor);
  const repairableDraft = await draftChanges(snapshot, plan);
  assert.deepEqual(repairableDraft, invalidAnchor);
  assert.throws(
    () => materializeDraft(snapshot, plan, repairableDraft),
    /exact unit/,
  );
  responseContent = JSON.stringify({ ...draft, title: "Unauthorized title" });
  await assert.rejects(draftChanges(snapshot, plan), /schema/);
  responseContent = "```json\n{}\n```";
  await assert.rejects(draftChanges(snapshot, plan), /invalid JSON/);
});

test("planned keeper cannot be deleted and its selected order stays intact", () => {
  const snapshot = buildSnapshot([
    page("a", "Ricavo: 450 euro.\n\nRicavo: 450 euro, al netto delle imposte."),
  ]);
  const keeper = snapshot.units[1];
  const plan = planFor(snapshot, {
    retainedUnitId: keeper.id,
    targetUnitIds: [keeper.id, snapshot.units[0].id],
  });
  assert.throws(
    () => materializeDraft(snapshot, plan, replace(snapshot, 1, "")),
    /retained unit cannot be deleted/,
  );
  const result = materializeDraft(snapshot, plan, replace(snapshot, 0, ""));
  assert.deepEqual(result.plan.targetUnitIds, [
    keeper.id,
    snapshot.units[0].id,
  ]);
  assert.equal(result.changes[0].after.markdown, keeper.text);
});

test("bounded summary patches keep factual corrections coherent and preserve other metadata", () => {
  const original = {
    ...page("a", "Ricavo: 450 euro. Fonte: 4500 euro."),
    summary: "Ricavo: 450 euro.",
  };
  const snapshot = buildSnapshot([original]);
  const plan = planFor(snapshot, {
    kind: "reconcile",
    resolution: "b",
    correctionUnitIds: [snapshot.units[0].id],
  });
  const draft = {
    ...replace(snapshot, 0, "Ricavo: 4500 euro. Fonte: 4500 euro."),
    summaryPatches: [
      { pageId: "a", before: original.summary, after: "Ricavo: 4500 euro." },
    ],
  };
  const { before, after } = materializeDraft(snapshot, plan, draft).changes[0];
  assert.equal(before.summary, "Ricavo: 450 euro.");
  assert.equal(after.summary, "Ricavo: 4500 euro.");
  assert.deepEqual(
    { ...after, markdown: before.markdown, summary: before.summary },
    before,
  );
  assert.throws(
    () => materializeDraft(snapshot, plan, { ...draft, patches: [] }),
    /summary edit requires/,
  );
  assert.throws(
    () =>
      materializeDraft(snapshot, plan, {
        ...draft,
        summaryPatches: [{ ...draft.summaryPatches[0], before: "stale" }],
      }),
    /summary does not match/,
  );
  assert.throws(
    () =>
      materializeDraft(snapshot, plan, {
        ...draft,
        summaryPatches: [...draft.summaryPatches, ...draft.summaryPatches],
      }),
    /duplicate summary/,
  );
  assert.throws(
    () =>
      materializeDraft(snapshot, plan, {
        ...draft,
        summaryPatches: [{ ...draft.summaryPatches[0], pageId: "other" }],
      }),
    /same target page/,
  );
  assert.throws(
    () =>
      materializeDraft(snapshot, plan, {
        ...draft,
        summaryPatches: [
          { ...draft.summaryPatches[0], after: original.summary },
        ],
      }),
    /no-op summary/,
  );
  assert.throws(
    () =>
      materializeDraft(snapshot, plan, {
        ...draft,
        summaryPatches: [
          { ...draft.summaryPatches[0], after: "x".repeat(2001) },
        ],
      }),
    /schema/,
  );
});

test("summary source URLs must remain represented on the final page", () => {
  const source = "https://example.com/source";
  const original = {
    ...page("a", "Ricavo: 450 euro. Fonte: 4500 euro."),
    summary: `Ricavo: 450 euro. [Fonte](${source}).`,
  };
  const snapshot = buildSnapshot([original]);
  const plan = planFor(snapshot, {
    kind: "reconcile",
    resolution: "b",
    correctionUnitIds: [snapshot.units[0].id],
  });
  const draft = {
    ...replace(snapshot, 0, "Ricavo: 4500 euro. Fonte: 4500 euro."),
    summaryPatches: [
      { pageId: "a", before: original.summary, after: "Ricavo: 4500 euro." },
    ],
  };
  assert.throws(
    () => materializeDraft(snapshot, plan, draft),
    /source or URL removed/,
  );
  draft.patches[0].after += ` [Fonte](${source}).`;
  assert.match(
    materializeDraft(snapshot, plan, draft).changes[0].after.markdown,
    /https:\/\/example.com\/source/,
  );
});

test("maintenance-only URLs may be removed only from patched selected residue units", () => {
  const url = "https://example.com/run/123";
  const snapshot = buildSnapshot([
    page(
      "a",
      `Fatto distinto: solo Italia.\n\nConsolidamento completato. [Rapporto](${url}).`,
    ),
  ]);
  const unit = snapshot.units[1];
  const plan = planFor(snapshot, {
    kind: "remove_maintenance_residue",
    targetUnitIds: [unit.id],
  });
  const draft = replace(snapshot, 1, "");
  assert.equal(
    materializeDraft(snapshot, plan, draft).changes[0].after.markdown,
    snapshot.units[0].text,
  );
  assert.throws(
    () => materializeDraft(snapshot, { ...plan, kind: "deduplicate" }, draft),
    /source or URL removed/,
  );
  snapshot.pages[0].summary = `Fonte utile: ${url}`;
  const loseSummarySource = {
    ...draft,
    summaryPatches: [
      {
        pageId: "a",
        before: snapshot.pages[0].summary,
        after: "Fatto distinto: solo Italia.",
      },
    ],
  };
  assert.throws(
    () => materializeDraft(snapshot, plan, loseSummarySource),
    /source or URL removed/,
  );
  const retained = materializeDraft(snapshot, plan, draft).changes[0].after;
  assert.equal(retained.summary, `Fonte utile: ${url}`);
});
