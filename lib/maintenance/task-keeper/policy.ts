// Task keeper thresholds and per-run limits (§8.5). No imports: the Workflow
// orchestrator reads the limits; prompts and the versioned policy id live in
// prompts.ts, which only steps import.

export const TASK_KEEPER_POLICY_ID = "task-keeper-v1";

export const TASK_KEEPER_THRESHOLDS = {
  duplicate: 0.8,
  mayBeDone: 0.85,
  criterionEvidence: 0.85,
  divergentState: 0.8,
  /** Candidate pairs for the open-task `duplicate` suggestion. */
  duplicateTitleSimilarity: 0.55,
  duplicateVectorDistance: 0.15,
} as const;

export const TASK_KEEPER_LIMITS = {
  openSuggestionsPerTask: 3,
  hygieneTasksPerRun: 150,
  duplicatePairsPerRun: 20,
  linkedPagesPerTask: 6,
  criteriaPerTask: 8,
  /** Characters of one page's Markdown in a hygiene request. */
  hygienePageCharacters: 8000,
  overdueDays: 2,
  triageAgingDays: 7,
  /** Consecutive provider failures that end the pass. */
  providerFailures: 3,
} as const;
