import type { JSONValue } from "ai";

type JevState = {
  before: JSONValue;
  after: JSONValue;
  evidence: JSONValue;
  operation: JSONValue;
};

export const JEV_STATE_ENCODING = {
  version: "jev-lossless-references-v1",
  description:
    "Jev-only representation: retain complete before/after pages, every source and citation, and operation metadata. Replace only provable duplicate text with references. Preserve incompatible fields and existing reference names unchanged; never truncate or select sources.",
  sourceMarkdownPath: "/before/markdown",
  offsetUnit: "UTF-16 code units",
  operationReferences: {
    before:
      "Complete before page. The omitted duplicate operation passage is exactly the substring identified by startInclusive and endExclusive.",
    after:
      "Complete after page. The omitted duplicate operation passage is exactly the substring identified by startInclusive and endExclusive.",
    evidence:
      "The complete unchanged citation array, identical to the omitted duplicate operation.evidence.",
  },
} as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Input is the adapter's already serialized JSON state; no input is mutated. */
export function encodeJevState(input: JevState): JevState {
  const state = structuredClone({
    before: input.before,
    after: input.after,
    evidence: input.evidence,
    operation: input.operation,
  });
  const operation = record(state.operation);
  if (!operation) return state;
  const before = record(state.before);
  const evidence = record(state.evidence);

  // Supplied references may point at fields that would otherwise be removed.
  // Keep the whole representation intact instead of reinterpreting those links.
  if (
    Object.hasOwn(operation, "references") ||
    (Array.isArray(evidence?.sources) &&
      evidence.sources.some((item) => {
        const source = record(item);
        return source && Object.hasOwn(source, "markdownRef");
      }))
  )
    return state;

  if (
    typeof operation.pageId === "string" &&
    typeof before?.markdown === "string" &&
    Array.isArray(evidence?.sources)
  ) {
    for (const item of evidence.sources) {
      const source = record(item);
      if (
        source &&
        !Object.hasOwn(source, "markdownRef") &&
        source.pageId === operation.pageId &&
        source.markdown === before.markdown
      ) {
        delete source.markdown;
        source.markdownRef = JEV_STATE_ENCODING.sourceMarkdownPath;
      }
    }
  }

  const references: Record<string, unknown> = {};
  for (const side of ["before", "after"] as const) {
    const page = record(state[side]);
    const passage = operation[side];
    if (typeof page?.markdown !== "string" || typeof passage !== "string")
      continue;
    const start = page.markdown.indexOf(passage);
    if (start < 0) continue;
    references[side] = {
      path: `/${side}/markdown`,
      description: JEV_STATE_ENCODING.operationReferences[side],
      startInclusive: start,
      endExclusive: start + passage.length,
      offsetUnit: JEV_STATE_ENCODING.offsetUnit,
    };
    delete operation[side];
  }
  if (
    Array.isArray(operation.evidence) &&
    Array.isArray(evidence?.citations) &&
    JSON.stringify(operation.evidence) === JSON.stringify(evidence.citations)
  ) {
    references.evidence = {
      path: "/evidence/citations",
      description: JEV_STATE_ENCODING.operationReferences.evidence,
    };
    delete operation.evidence;
  }
  if (Object.keys(references).length) operation.references = references;
  return state;
}
