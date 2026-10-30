import type { TaskLinkRole } from "../../tasks/types";
import type {
  Answer,
  EvaluationRequest,
  Json,
  Question,
} from "../consolidator/types";
import {
  renderTaskPrompt,
  TASK_LINK_POLICY,
  type TaskPromptProfile,
} from "./policy";

// One Jev request per task (§8.3 step 4): boolean questions only, never an
// open choice of role.

export interface JevTask {
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

export interface JevPage {
  title: string;
  type: string;
  summary: string;
  excerpt: string;
}

export interface PageJudgment {
  relevant: number;
  governs?: number;
  stakeholder?: number;
}

export type LinkedRole = Extract<
  TaskLinkRole,
  "context" | "decision" | "stakeholder"
>;

const pageKey = (index: number) => `p${index + 1}`;
const asksGoverns = (type: string) => type === "decision";
const asksStakeholder = (type: string) =>
  type === "person" || type === "company";

export function buildLinkRequest(
  task: JevTask,
  pages: JevPage[],
  profile?: TaskPromptProfile,
): EvaluationRequest {
  if (!pages.length || pages.length > TASK_LINK_POLICY.maxCandidates)
    throw new Error("A link request needs 1 to 12 candidate pages.");
  const questions: Record<string, Question> = {};
  const statePages: Record<string, Json> = {};
  pages.forEach((page, index) => {
    const key = pageKey(index);
    statePages[key] = {
      title: page.title,
      type: page.type,
      summary: page.summary.slice(0, TASK_LINK_POLICY.summaryCharacters),
      excerpt: page.excerpt.slice(0, TASK_LINK_POLICY.excerptCharacters),
    };
    const slot = `pages.${key}`;
    questions[`relevant_${key}`] = {
      type: "boolean",
      instructions: renderTaskPrompt("relevant", slot, profile),
    };
    if (asksGoverns(page.type))
      questions[`governs_${key}`] = {
        type: "boolean",
        instructions: renderTaskPrompt("governs", slot, profile),
      };
    else if (asksStakeholder(page.type))
      questions[`stakeholder_${key}`] = {
        type: "boolean",
        instructions: renderTaskPrompt("stakeholder", slot, profile),
      };
  });
  return {
    state: {
      task: {
        title: task.title,
        description: task.description.slice(
          0,
          TASK_LINK_POLICY.descriptionCharacters,
        ),
        acceptanceCriteria: task.acceptanceCriteria,
      },
      pages: statePages,
    },
    questions,
  };
}

function probability(answer: Answer | undefined): number {
  if (answer?.type !== "boolean")
    throw new Error("A task link answer is missing or not boolean.");
  return answer.probability;
}

/** Per-page probabilities in candidate order. */
export function readJudgments(
  pages: Pick<JevPage, "type">[],
  answers: Record<string, Answer>,
): PageJudgment[] {
  return pages.map((page, index) => {
    const key = pageKey(index);
    return {
      relevant: probability(answers[`relevant_${key}`]),
      ...(asksGoverns(page.type)
        ? { governs: probability(answers[`governs_${key}`]) }
        : {}),
      ...(asksStakeholder(page.type)
        ? { stakeholder: probability(answers[`stakeholder_${key}`]) }
        : {}),
    };
  });
}

/** Confidence of a role for a judgment: the weakest question it rests on. */
export function roleScore(judgment: PageJudgment, role: LinkedRole): number {
  if (role === "decision")
    return Math.min(judgment.relevant, judgment.governs ?? 0);
  if (role === "stakeholder")
    return Math.min(judgment.relevant, judgment.stakeholder ?? 0);
  return judgment.relevant;
}

/** §8.3 step 5: relevant ≥0.80, then decision or stakeholder ≥0.80, else context. */
export function linkRole(
  judgment: PageJudgment,
): { role: LinkedRole; score: number } | null {
  if (judgment.relevant < TASK_LINK_POLICY.relevant) return null;
  if ((judgment.governs ?? 0) >= TASK_LINK_POLICY.governs)
    return { role: "decision", score: roleScore(judgment, "decision") };
  if ((judgment.stakeholder ?? 0) >= TASK_LINK_POLICY.stakeholder)
    return { role: "stakeholder", score: roleScore(judgment, "stakeholder") };
  return { role: "context", score: judgment.relevant };
}
