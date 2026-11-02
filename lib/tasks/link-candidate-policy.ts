import { POLICY } from "../maintenance/consolidator/types";

export const TASK_LINK_CANDIDATE_POLICY = {
  id: "task-link-candidates-v1",
  threshold: 0.8,
  maxEvaluatedUnits: 48,
  maxDecisionCandidates: 32,
  questionsPerRequest: POLICY.questionsPerRequest,
} as const satisfies {
  id: string;
  threshold: number;
  maxEvaluatedUnits: number;
  maxDecisionCandidates: number;
  questionsPerRequest: number;
};
