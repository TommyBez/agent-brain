import type { LinkType } from "../../brain/types";
import {
  EVIDENCE_RULES,
  type PromptProfile,
  renderPrompt,
  resolvePromptProfile,
} from "./prompts";
import type { Question } from "./types";

const RULES = EVIDENCE_RULES;

export function booleanQuestion(instructions: string): Question {
  return { type: "boolean", instructions: instructions + RULES };
}

export function choiceQuestion(
  instructions: string,
  criteria: Record<string, string>,
): Question {
  return { type: "choice", instructions: instructions + RULES, criteria };
}

export function screeningQuestions(
  pair: boolean,
  profile: PromptProfile = resolvePromptProfile(),
): Record<string, Question> {
  const scope = pair ? "across pages[0] and pages[1]" : "within pages[0]";
  const questions: Record<string, Question> = {
    duplicate: booleanQuestion(renderPrompt("duplicate", { scope }, profile)),
    conflict: booleanQuestion(renderPrompt("conflict", { scope }, profile)),
  };
  if (pair) {
    questions.link_ab = booleanQuestion(
      renderPrompt("link", { source: "0", target: "1" }, profile),
    );
    questions.link_ba = booleanQuestion(
      renderPrompt("link", { source: "1", target: "0" }, profile),
    );
  } else
    questions.residue = booleanQuestion(renderPrompt("residue", {}, profile));
  return questions;
}

export function preparationQuestions(
  kind: "duplicate" | "conflict" | "residue",
  profile: PromptProfile = resolvePromptProfile(),
): Record<string, Question> {
  if (kind === "residue")
    return {
      removable: booleanQuestion(renderPrompt("removable", {}, profile)),
    };
  if (kind === "duplicate")
    return {
      destination: choiceQuestion(renderPrompt("destination", {}, profile), {
        a: "Retain shared information at target[0].",
        b: "Retain shared information at target[1].",
        equivalent: "Both locations are equally suitable canonical homes.",
        none: "Neither location is a supported destination for consolidation.",
      }),
      actionable: booleanQuestion(renderPrompt("actionable", {}, profile)),
    };
  return {
    resolution: choiceQuestion(renderPrompt("resolution", {}, profile), {
      a: "Evidence establishes target[0]'s claim and explicitly supports correcting the incompatible claim in target[1].",
      b: "Evidence establishes target[1]'s claim and explicitly supports correcting the incompatible claim in target[0].",
      temporal:
        "Evidence documents successive factual states; clarify their actual periods while preserving history.",
      scope:
        "Evidence establishes different scopes; clarify the distinction without discarding either fact.",
      insufficient:
        "An intervention needs a specifically referenced source not supplied here.",
      none: "No supported useful correction or clarification can be made from the evidence.",
    }),
  };
}

/** Evaluate the only eligible pair and its speculative intervention together. */
export function pairPreparationQuestions(
  kind: "duplicate" | "conflict",
  profile: PromptProfile = resolvePromptProfile(),
): Record<string, Question> {
  const premise =
    kind === "duplicate"
      ? "target[0] and target[1] repeat factual information"
      : "target[0] and target[1] contain apparently incompatible claims about the same entity and scope";
  return {
    counterpart: booleanQuestion(
      renderPrompt(`counterpart_${kind}`, {}, profile),
    ),
    ...Object.fromEntries(
      Object.entries(preparationQuestions(kind, profile)).map(
        ([id, question]) => [
          id,
          {
            ...question,
            instructions: `Assuming ${premise}, answer the following intervention question independently: ${question.instructions}`,
          },
        ],
      ),
    ),
  };
}

export const RELATION_MEANINGS: Record<LinkType, string> = {
  works_at: "the source person works at the target organization",
  owns: "the source entity owns the target entity or resource",
  part_of: "the source entity is a constituent part of the target entity",
  relates_to:
    "a concrete specific relationship connects source to target and is useful for navigation; shared topic alone is insufficient",
  decided_in:
    "the source decision or subject was decided in the target meeting, article or recorded context",
  references:
    "the source content explicitly cites or refers to the target entity or document",
  depends_on:
    "the source entity or activity depends on the target entity, resource or activity",
  supersedes:
    "the source replaces the target, supported by substantive succession evidence, not page update time",
  collaborates_with: "the source entity collaborates with the target entity",
};

export function localizationQuestion(
  kind: "duplicate" | "conflict" | "residue",
  index: number,
  profile: PromptProfile = resolvePromptProfile(),
) {
  return booleanQuestion(
    renderPrompt(`localize_${kind}`, { index: String(index) }, profile),
  );
}

export function partnerQuestion(
  kind: "duplicate" | "conflict",
  anchor: string,
  options: { id: string }[],
  profile: PromptProfile = resolvePromptProfile(),
) {
  return choiceQuestion(
    renderPrompt(`partner_${kind}`, { anchor }, profile),
    Object.fromEntries([
      ["none", "No suitable partner."],
      ...options.map((unit, index) => [
        `p${index}`,
        `Passage ${unit.id} in units.`,
      ]),
    ]),
  );
}

export function relationQuestion(
  profile: PromptProfile = resolvePromptProfile(),
) {
  return choiceQuestion(renderPrompt("relation", {}, profile), {
    none: "No supported missing relationship.",
    ...RELATION_MEANINGS,
  });
}
