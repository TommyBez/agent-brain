import {
  DECISION_POLICY,
  LOCALIZATION_THRESHOLD,
  SCREENING_THRESHOLD,
  verificationThreshold,
} from "../../lib/maintenance/consolidator/decision-policy";
import {
  BASELINE_PROFILE,
  type PromptTask,
} from "../../lib/maintenance/consolidator/prompts";
import {
  localizationQuestion,
  pairPreparationQuestions,
  partnerQuestion,
  preparationQuestions,
  RELATION_MEANINGS,
  relationQuestion,
  screeningQuestions,
} from "../../lib/maintenance/consolidator/questions";
import type {
  Answer,
  EvaluationRequest,
} from "../../lib/maintenance/consolidator/types";
import { verificationQuestion } from "../../lib/maintenance/consolidator/verifier";
import type { Example } from "./types";

export const TASKS: Record<
  PromptTask,
  {
    description: string;
    labels: string[];
    threshold: number;
    invariant: string;
  }
> = {
  verification: {
    description:
      "Evaluate the fixed post-edit requirement against original evidence, the authorized operation and the complete final draft. The editable prompt is optional shared guidance; every individual requirement and the evidence prefix remain immutable.",
    labels: ["false", "true"],
    threshold: DECISION_POLICY.verifier.objective,
    invariant:
      "Never waive or redefine an individual verification requirement. Evaluate only its own claims and preserve all original facts, sources, qualifiers and uncertainty unless the exact correction is planned and supported. Reject harmful drafts without rejecting valid preservation, supported corrections or vacuously satisfied qualifiers. Different question IDs keep their original application thresholds.",
  },
  ...(Object.fromEntries(
    (["duplicate", "conflict", "residue"] as const).map((kind) => [
      `localize_${kind}`,
      {
        description: `Locate a passage containing ${kind} within the complete ordered page context.`,
        labels: ["false", "true"],
        threshold: LOCALIZATION_THRESHOLD,
        invariant:
          "Localization identifies a candidate span, never permission to delete it. Other units provide context. Original requests and genuine uncertainty remain knowledge; topic alone is insufficient for duplicate or conflict.",
      },
    ]),
  ) as Record<
    "localize_duplicate" | "localize_conflict" | "localize_residue",
    {
      description: string;
      labels: string[];
      threshold: number;
      invariant: string;
    }
  >),
  ...(Object.fromEntries(
    (["duplicate", "conflict"] as const).map((kind) => [
      `partner_${kind}`,
      {
        description: `Select the candidate passage that ${kind === "duplicate" ? "repeats factual knowledge" : "contains an incompatible claim about the same entity and scope"} relative to the anchor.`,
        labels: ["none", "p0", "p1", "p2"],
        threshold: DECISION_POLICY.analyst.choiceProbability,
        invariant:
          "Select only among the supplied candidate IDs. Do not infer answers from position or identifiers. Shared topic is insufficient. Detection does not require an authorized correction or deletion. Use none when no candidate qualifies.",
      },
    ]),
  ) as Record<
    "partner_duplicate" | "partner_conflict",
    {
      description: string;
      labels: string[];
      threshold: number;
      invariant: string;
    }
  >),
  ...(Object.fromEntries(
    (["duplicate", "conflict"] as const).map((kind) => [
      `counterpart_${kind}`,
      {
        description: `Confirm that the exact two target passages ${kind === "duplicate" ? "repeat factual information" : "contain apparently incompatible claims about the same entity and scope"}.`,
        labels: ["false", "true"],
        threshold: DECISION_POLICY.analyst.yes,
        invariant:
          "This gate identifies the relationship, not whether editing is supported or useful. Shared topic alone is insufficient; use the complete page context.",
      },
    ]),
  ) as Record<
    "counterpart_duplicate" | "counterpart_conflict",
    {
      description: string;
      labels: string[];
      threshold: number;
      invariant: string;
    }
  >),
  destination: {
    description: "Choose the canonical home for shared target knowledge.",
    labels: ["a", "b", "equivalent", "none"],
    threshold: DECISION_POLICY.analyst.choiceProbability,
    invariant:
      "Technical update timestamps do not establish canonical ownership. Equivalent means both equally suitable; none means neither is supported. Do not always prefer one position or discard distinct details.",
  },
  removable: {
    description:
      "Decide whether the entire target passage can be removed as maintenance residue.",
    labels: ["false", "true"],
    threshold: DECISION_POLICY.analyst.yes,
    invariant:
      "Only activity-only maintenance and agent-added human follow-up can be removed. A mixed passage containing any unique useful fact, source, original request, uncertainty or necessary context is not removable in its entirety.",
  },
  relation: {
    description:
      "Select the exact supported missing directed link type from source to target.",
    labels: ["none", ...Object.keys(RELATION_MEANINGS)],
    threshold: DECISION_POLICY.analyst.choiceProbability,
    invariant:
      "All nine fixed relation definitions retain their meanings. Respect direction and entity identity. Do not duplicate existing matching typed links or equate topic similarity with evidence. Generic relates_to is not a fallback for absent evidence.",
  },
  duplicate: {
    description:
      "Detect substantial repeated factual knowledge within one page or across two pages, before any editing decision.",
    labels: ["false", "true"],
    threshold: SCREENING_THRESHOLD,
    invariant:
      "Shared topics alone are not duplicates. Flag existence without assuming any fact may be deleted.",
  },
  conflict: {
    description:
      "Detect apparently incompatible claims about the same entity/scope requiring correction or clarification.",
    labels: ["false", "true"],
    threshold: SCREENING_THRESHOLD,
    invariant:
      "Detection does not require a supported resolution. Already explicit different scopes/periods are compatible.",
  },
  link: {
    description:
      "Detect an evidenced useful directed relationship missing from the source page links.",
    labels: ["false", "true"],
    threshold: SCREENING_THRESHOLD,
    invariant:
      "Respect direction, entity identity and existing edges; topical similarity is insufficient.",
  },
  residue: {
    description:
      "Detect removable consolidator diaries or agent-invented human follow-ups.",
    labels: ["false", "true"],
    threshold: SCREENING_THRESHOLD,
    invariant:
      "Preserve original user requests, subject knowledge and genuine uncertainty. Agent activity is not subject knowledge.",
  },
  actionable: {
    description:
      "Decide whether consolidation of the two supplied target passages would meaningfully improve their pages.",
    labels: ["false", "true"],
    threshold: DECISION_POLICY.analyst.yes,
    invariant:
      "Preserve distinct facts/sources and necessary local context. Complementary facts, citation-only repetition, useful summaries and cosmetic rewrites are not actionable duplication. Do not prejudge a hypothetical draft.",
  },
  resolution: {
    description:
      "Choose which intervention on conflicting target passages is established by the supplied sources.",
    labels: ["a", "b", "temporal", "scope", "insufficient", "none"],
    threshold: DECISION_POLICY.analyst.choiceProbability,
    invariant:
      "Only supplied source evidence can authorize a correction; page timestamps and confident wording are not factual authority. Keep all six fixed criteria. Unsupported interventions must not be authorized.",
  },
};

/** The same builders as production; dataset labels/IDs/proofs never enter state. */
export function requestFor(
  example: Example,
  prompt: string,
): EvaluationRequest {
  const profile = {
    id: "offline",
    prompts: { ...BASELINE_PROFILE.prompts, [example.task]: prompt },
  };
  if (example.task === "verification") {
    if (!example.context?.verification)
      throw new Error("Missing verification context");
    return {
      state: example.state,
      questions: {
        decision: verificationQuestion(
          example.context.verification.requirement,
          profile,
        ),
      },
    };
  }
  if (example.task.startsWith("localize_")) {
    if (example.context?.unitIndex === undefined)
      throw new Error("Missing localization index");
    return {
      state: example.state,
      questions: {
        decision: localizationQuestion(
          example.task.slice(9) as "duplicate" | "conflict" | "residue",
          example.context.unitIndex,
          profile,
        ),
      },
    };
  }
  if (example.task.startsWith("partner_")) {
    if (!example.context?.anchorId || !example.context.optionIds)
      throw new Error("Missing partner context");
    return {
      state: example.state,
      questions: {
        decision: partnerQuestion(
          example.task.slice(8) as "duplicate" | "conflict",
          example.context.anchorId,
          example.context.optionIds.map((id) => ({ id })),
          profile,
        ),
      },
    };
  }
  if (example.task.startsWith("counterpart_"))
    return {
      state: example.state,
      questions: {
        decision: pairPreparationQuestions(
          example.task.slice(12) as "duplicate" | "conflict",
          profile,
        ).counterpart,
      },
    };
  if (example.task === "destination" || example.task === "removable")
    return {
      state: example.state,
      questions: {
        decision: preparationQuestions(
          example.task === "destination" ? "duplicate" : "residue",
          profile,
        )[example.task],
      },
    };
  if (example.task === "relation")
    return {
      state: example.state,
      questions: { decision: relationQuestion(profile) },
    };
  let question =
    example.task === "actionable"
      ? preparationQuestions("duplicate", profile).actionable
      : example.task === "resolution"
        ? preparationQuestions("conflict", profile).resolution
        : screeningQuestions(example.pair, profile)[
            example.task === "link" ? `link_${example.direction}` : example.task
          ];
  if (!question)
    throw new Error(`Task incompatible with example: ${example.id}`);
  if (example.direct) {
    if (!["actionable", "resolution"].includes(example.task))
      throw new Error("Invalid direct preparation");
    const premise =
      example.task === "actionable"
        ? "target[0] and target[1] repeat factual information"
        : "target[0] and target[1] contain apparently incompatible claims about the same entity and scope";
    question = {
      ...question,
      instructions: `Assuming ${premise}, answer the following intervention question independently: ${question.instructions}`,
    };
  }
  return { state: example.state, questions: { decision: question } };
}

export function classify(
  task: PromptTask,
  answer: Answer,
  context?: Example["context"],
) {
  const threshold =
    task === "verification" && context?.verification
      ? verificationThreshold(context.verification.questionId)
      : TASKS[task].threshold;
  if (answer.type === "boolean") return String(answer.probability >= threshold);
  return answer.probabilities[answer.choice] >= threshold
    ? answer.choice
    : "abstain";
}
