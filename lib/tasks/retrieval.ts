import type { SearchResult } from "../brain/types";

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
export const RETRIEVAL_POLICY = { lexicalTerms: 8 } as const;
const STOPWORDS = new Set(
  (
    "and are but can for from has have its not one per our the this that was " +
    "were will with what when which who why how all any into onto over than " +
    "then them they you your about after before also more most such only " +
    "agli alla alle allo anche come con cui dai dal dall dalla dalle degli dei " +
    "del dell della delle dello deve devono dopo era essere fra gli hanno " +
    "negli dagli sugli " +
    "lei lui nei nel nell nella nelle nello non per perché più poi quale " +
    "quando quella quelle quello questa queste questo sono sua sue sui sul " +
    "sull sulla sulle suo tra una uno che chi ogni senza sia stato stata " +
    "verso entro fare fatto"
  ).split(" "),
);

/** Distinctive words of `text` as a websearch OR query; Postgres would AND them. */
export function lexicalQuery(
  text: string,
  maxTerms: number = RETRIEVAL_POLICY.lexicalTerms,
): string {
  const terms: string[] = [];
  for (const match of text
    .normalize("NFKC")
    .toLocaleLowerCase("it-IT")
    .matchAll(/[\p{L}\p{N}]{3,}/gu)) {
    const term = match[0];
    if (STOPWORDS.has(term) || terms.includes(term)) continue;
    terms.push(term);
    if (terms.length >= maxTerms) break;
  }
  return terms.length ? terms.join(" or ") : squash(text).slice(0, 200);
}

/** Pure candidate ranking. Never writes links or task embeddings. */
export function planRetrieval(
  results: Pick<SearchResult, "id">[],
  excludedPageIds: readonly string[] = [],
) {
  const blocked = new Set(excludedPageIds);
  return results
    .filter((hit) => {
      if (blocked.has(hit.id)) return false;
      blocked.add(hit.id);
      return true;
    })
    .slice(0, 10)
    .map((hit, index) => ({ pageId: hit.id, rank: index + 1 }));
}
