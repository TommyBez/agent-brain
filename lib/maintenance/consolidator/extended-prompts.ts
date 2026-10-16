/** Exact original instructions. Verification adds optional guidance without editing any requirement. */
const localization = (instruction: string) =>
  `Select whether units[{index}] ${instruction}. All passages of each page are supplied in units in source order; use them as the complete page context. This question identifies an edit target, not permission to remove it.`;
const partner = (instruction: string) =>
  `For anchor passage {anchor} in units, which of the candidate passages listed in this question's choices ${instruction}? Identify the counterpart only; a supported correction or deletion is NOT required. Select none when no counterpart exists; shared topic alone is insufficient.`;
const counterpart = (premise: string) =>
  `Do ${premise}? Judge these exact two passages in their complete page context. Shared topic alone is insufficient. Identify the relationship only; a supported correction or deletion is not required.`;

export const EXTENDED_BASELINE_PROMPTS = {
  verification: "",
  localize_duplicate: localization(
    "contains factual information substantially repeated by another passage in the supplied page or opposite page of this pair",
  ),
  localize_conflict: localization(
    "contains a claim involved in the apparent incompatibility or temporal/scope ambiguity signaled between passages in these pages",
  ),
  localize_residue: localization(
    "contains consolidator activity-only text or agent-added human follow-up, rather than an original user request",
  ),
  partner_duplicate: partner("repeats factual information from that anchor"),
  partner_conflict: partner(
    "makes a claim apparently incompatible with that anchor about the same entity and scope",
  ),
  counterpart_duplicate: counterpart(
    "target[0] and target[1] repeat factual information",
  ),
  counterpart_conflict: counterpart(
    "target[0] and target[1] contain apparently incompatible claims about the same entity and scope",
  ),
  destination:
    "Where should the shared information in target[0] and target[1] be retained, considering their complete containing pages? Choose the appropriate canonical home, not the more recent technical timestamp. Select equivalent when both locations are equally suitable; code will break the tie deterministically.",
  removable:
    "Can target[0] be removed in its entirety without losing any distinct subject knowledge, original request, factual uncertainty, useful citation or necessary local context? Only consolidator activity and agent-added human follow-up may be removed.",
  relation:
    "Which exact useful directed relationship from source to target is established by their text and missing from source.links? Entities must be unambiguous; shared topic is insufficient. Select none if the matching relationship already exists.",
} as const;
export const EXTENDED_PROMPT_TASKS = [
  "verification",
  "localize_duplicate",
  "localize_conflict",
  "localize_residue",
  "partner_duplicate",
  "partner_conflict",
  "counterpart_duplicate",
  "counterpart_conflict",
  "destination",
  "removable",
  "relation",
] as const;
export type ExtendedPromptTask = (typeof EXTENDED_PROMPT_TASKS)[number];
