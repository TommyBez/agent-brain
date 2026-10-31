import type { EvaluationRequest, Json } from "./types";

/** Reversible identifiers only; source text and all questions remain present. */
export function encodeVerificationRequest(
  request: EvaluationRequest,
): EvaluationRequest {
  const state = request.state as Record<string, Json>;
  const ids = new Set<string>();
  for (const key of [
    "originalPages",
    "resultPages",
    "originalUnits",
    "resultUnits",
  ]) {
    for (const item of state[key] as { id: string }[])
      if (item.id.length >= 32) ids.add(item.id);
  }
  const serialized = JSON.stringify(request);
  const aliases = new Map<string, string>();
  let index = 0;
  for (const id of ids) {
    let alias: string;
    do {
      alias = `ref${index++}`;
    } while (serialized.includes(alias));
    aliases.set(id, alias);
  }
  const encode = (value: Json): Json => {
    if (typeof value === "string") return aliases.get(value) ?? value;
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, encode(entry)]),
      );
    return value;
  };
  // Longer unit IDs contain page IDs: replace them before their prefixes.
  const replacements = [...aliases].sort(([a], [b]) => b.length - a.length);
  return {
    state: {
      ...(encode(state) as Record<string, Json>),
      identifiers: Object.fromEntries(
        [...aliases].map(([id, alias]) => [alias, id]),
      ),
    },
    questions: Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [
        id,
        {
          ...question,
          instructions:
            replacements.reduce(
              (text, [original, alias]) => text.replaceAll(original, alias),
              question.instructions,
            ) +
            " Short references are lossless aliases for the original IDs in state.identifiers; they preserve identity only, not semantic equivalence. All evidence and all criteria still apply.",
        },
      ]),
    ),
  };
}
