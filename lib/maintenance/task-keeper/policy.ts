// Task keeper thresholds and per-run limits (§8.5). No imports: the Workflow
// orchestrator reads the limits; prompts and the versioned policy id live in
// prompts.ts, which only steps import.

export const TASK_KEEPER_POLICY_ID = "task-keeper-v1";

export const TASK_KEEPER_THRESHOLDS = {
  /** "Contains explicit action items or commitments attributed to someone?" */
  screening: 0.8,
  /** Passage localization, as in the consolidator. */
  localization: 0.7,
  explicitCommitment: 0.8,
  actorSupported: 0.8,
  dueSupported: 0.8,
  /** At or above: the source reports the item as done, so no task. */
  alreadyDone: 0.8,
  duplicate: 0.8,
  mayBeDone: 0.85,
  criterionEvidence: 0.85,
  divergentState: 0.8,
  /** Candidate pairs for the open-task `duplicate` suggestion. */
  duplicateTitleSimilarity: 0.55,
  duplicateVectorDistance: 0.15,
  /** Looser candidate generation for extraction dedupe (Jev decides). */
  extractionCandidateSimilarity: 0.3,
  extractionCandidateDistance: 0.35,
} as const;

export const TASK_KEEPER_LIMITS = {
  /** New tasks per run; the rest waits for the next run. */
  newTasksPerRun: 50,
  /** Changed pages examined per run (screening requests). */
  pagesPerRun: 200,
  itemsPerPage: 20,
  candidatesPerItem: 5,
  openSuggestionsPerTask: 3,
  hygieneTasksPerRun: 150,
  duplicatePairsPerRun: 20,
  linkedPagesPerTask: 6,
  criteriaPerTask: 8,
  /** Characters of one page's Markdown in a hygiene request. */
  hygienePageCharacters: 8000,
  /** Characters of the units sent to the extraction model. */
  extractionCharacters: 60_000,
  /** Recurrence occurrences instantiated per series per run (latest kept). */
  occurrencesPerSeries: 7,
  overdueDays: 2,
  triageAgingDays: 7,
  /** Consecutive provider failures that end the pass. */
  providerFailures: 3,
} as const;
