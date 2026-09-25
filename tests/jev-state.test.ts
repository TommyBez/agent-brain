import assert from "node:assert/strict";
import test from "node:test";
import { DEFECT_CONSOLIDATION_QUESTIONS } from "../lib/maintenance/consolidation-defect-questions";
import { evaluateConsolidationProposal } from "../lib/maintenance/jev";
import { encodeJevState } from "../lib/maintenance/jev-state";

function fixture() {
  const before = {
    id: "target",
    markdown: "🌡️ Registro\n\nValore: 8.\nValore: 8.",
  };
  const after = { id: "target", markdown: "🌡️ Registro\n\nValore: 8." };
  const citations = [{ pageId: "target", version: 3, quote: "Valore: 8." }];
  return {
    before,
    after,
    evidence: {
      citations,
      sources: [
        { pageId: "other", markdown: "Fonte distinta, data distinta." },
        { pageId: "target", version: 3, markdown: before.markdown, links: [] },
        { pageId: "same-text-other-id", markdown: before.markdown },
      ],
    },
    operation: {
      pageId: "target",
      reason: "Rimuove la ripetizione.",
      before: "Valore: 8.\nValore: 8.",
      after: "Valore: 8.",
      evidence: structuredClone(citations),
    },
  };
}

type Encoded = {
  before: { markdown: string };
  after: { markdown: string };
  evidence: { sources: Record<string, unknown>[]; citations: unknown[] };
  operation: Record<string, unknown> & {
    references: Record<
      "before" | "after" | "evidence",
      { path: string; startInclusive: number; endExclusive: number }
    >;
  };
};

test("Jev encoding reconstructs every duplicate with full pages, sources and Unicode offsets intact", () => {
  const input = { ...fixture(), expected: "PRIVATE_REFERENCE_LABEL" };
  const original = structuredClone(input);
  const encoded = encodeJevState(input) as Encoded;
  assert.deepEqual(input, original);
  assert.deepEqual(Object.keys(encoded), [
    "before",
    "after",
    "evidence",
    "operation",
  ]);
  assert.equal(
    JSON.stringify(encoded).includes("PRIVATE_REFERENCE_LABEL"),
    false,
  );
  assert.deepEqual(encoded.before, input.before);
  assert.deepEqual(encoded.after, input.after);
  assert.deepEqual(encoded.evidence.citations, input.evidence.citations);
  assert.deepEqual(encoded.evidence.sources[0], input.evidence.sources[0]);
  assert.deepEqual(encoded.evidence.sources[2], input.evidence.sources[2]);
  assert.deepEqual(encoded.evidence.sources[1], {
    pageId: "target",
    version: 3,
    links: [],
    markdownRef: "/before/markdown",
  });

  const restored = structuredClone(encoded);
  const target = restored.evidence.sources[1];
  target.markdown = restored.before.markdown;
  delete target.markdownRef;
  for (const side of ["before", "after"] as const) {
    const range = encoded.operation.references[side];
    assert.equal(range.path, `/${side}/markdown`);
    assert.equal(range.startInclusive, input[side].markdown.indexOf("Valore"));
    // The leading emoji uses two UTF-16 code units, not one code point.
    assert.notEqual(
      range.startInclusive,
      [...input[side].markdown.slice(0, range.startInclusive)].length,
    );
    restored.operation[side] = encoded[side].markdown.slice(
      range.startInclusive,
      range.endExclusive,
    );
  }
  assert.equal(
    encoded.operation.references.evidence.path,
    "/evidence/citations",
  );
  restored.operation.evidence = encoded.evidence.citations;
  delete (restored.operation as Record<string, unknown>).references;
  const { expected: _expected, ...fourFields } = input;
  assert.deepEqual(restored, fourFields);
});

test("unproved duplicates, incompatible structures and pre-existing reference names are preserved", () => {
  const changed = fixture();
  changed.evidence.sources[1].markdown = "Different source text.";
  changed.operation.before = "Not present in the before page.";
  changed.operation.after = "Not present in the after page.";
  changed.operation.evidence[0].quote = "Different citation.";
  assert.deepEqual(encodeJevState(changed), changed);

  for (const field of ["references", "markdownRef"] as const) {
    const collision = fixture();
    if (field === "references") {
      Object.assign(collision.operation, {
        references: { before: "/evidence/sources/1/markdown" },
      });
    } else {
      Object.assign(collision.evidence.sources[0], {
        markdownRef: "/operation/before",
      });
    }
    const original = structuredClone(collision);
    assert.deepEqual(encodeJevState(collision), collision);
    assert.deepEqual(collision, original);
  }

  for (const operation of [
    null,
    "original text",
    [],
    { before: 4, after: null, evidence: "not citations" },
  ]) {
    const input = {
      before: "page text",
      after: [],
      evidence: "source text",
      operation,
    };
    assert.deepEqual(encodeJevState(input), input);
  }
});

test("the SDK receives only the compact four-field state, including exact empty passage ranges", async () => {
  const input = {
    ...fixture(),
    operation: { pageId: "target", before: "", after: "", evidence: [] },
    expected: "PRIVATE_LABEL",
  };
  const original = structuredClone(input);
  let calls = 0;
  await evaluateConsolidationProposal(input, {
    apiKey: "test-key",
    questions: DEFECT_CONSOLIDATION_QUESTIONS,
    fetch: async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init?.body));
      assert.deepEqual(request.questions, DEFECT_CONSOLIDATION_QUESTIONS);
      assert.deepEqual(Object.keys(request.state), [
        "before",
        "after",
        "evidence",
        "operation",
      ]);
      assert.equal(JSON.stringify(request).includes("PRIVATE_LABEL"), false);
      assert.deepEqual(request.state.before, input.before);
      assert.deepEqual(request.state.after, input.after);
      for (const side of ["before", "after"] as const) {
        const reference = request.state.operation.references[side];
        assert.equal(reference.path, `/${side}/markdown`);
        assert.equal(reference.startInclusive, 0);
        assert.equal(reference.endExclusive, 0);
        assert.equal(reference.offsetUnit, "UTF-16 code units");
        assert.equal(
          request.state[side].markdown.slice(
            reference.startInclusive,
            reference.endExclusive,
          ),
          "",
        );
        assert.equal(Object.hasOwn(request.state.operation, side), false);
      }
      // Empty operation evidence is not the nonempty citation array: retain it.
      assert.deepEqual(request.state.operation.evidence, []);
      return Response.json({
        answers: Object.fromEntries(
          Object.keys(DEFECT_CONSOLIDATION_QUESTIONS).map((key) => [
            key,
            { type: "boolean", probability: 0.1 },
          ]),
        ),
        warnings: [],
        usage: { inputTokens: 20, outputTokens: 4 },
      });
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(input, original);
});
