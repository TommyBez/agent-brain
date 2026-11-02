import type { PageCandidate } from "./link-candidates";
/** Cancel never calls this helper. Confirmation applies only explicitly checked refs. */
export function checkedCandidates(
  candidates: PageCandidate[],
  selected: readonly string[],
) {
  const checked = new Set(selected);
  return candidates.filter((candidate) => checked.has(candidate.pageRef));
}
