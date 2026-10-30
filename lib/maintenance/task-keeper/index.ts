import type {
  TaskPhaseContext,
  TaskPhaseHalt,
  TaskPhaseResult,
} from "../task-phase";
import { TASK_KEEPER_LIMITS } from "./policy";
import {
  completeKeeperPage,
  extractKeeperPage,
  finishTaskKeeper,
  keeperDeterministicHygiene,
  keeperDuplicatePair,
  keeperRecurrences,
  keeperTaskHygiene,
  prepareKeeperHygiene,
  prepareTaskKeeper,
  type StepStatus,
  screenKeeperPage,
  settleKeeperItem,
} from "./steps";

/** Job result of the `task_keeper` phase (§8.5). */
export type TaskKeeperResult = TaskPhaseResult & {
  /** Changed pages in scope (all pages on the first run), minus exclusions. */
  pagesConsidered: number;
  pagesScreened: number;
  unitsReused: number;
  /** Tasks created in triage. */
  created: number;
  /** `new_source` suggestions added to existing tasks. */
  newSources: number;
  /** Other hygiene suggestions opened. */
  suggestions: number;
  /** Recurrence occurrences instantiated. */
  occurrences: number;
  /**
   * Pages left for the next run: per-run limits, failures and pages over
   * Jev's size limit (`oversizedPages`, never marked done). Pages waiting
   * only for a free suggestion slot are `cappedPages`, not counted here.
   */
  remainingPages: number;
};

/** Nightly `task_keeper` phase, after embeddings and before task_links.
 *
 * Runs at Workflow level inside nightlyMaintenance's owner lock, like
 * `consolidate`: do I/O only in "use step" functions. Charge Jev through
 * `evaluatePersisted(…, budgetedGateway(ownerId, runId, "task_keeper"))` and
 * DeepSeek through the same gateway, and return `partial` with a halt, never
 * throw, when the budget, Jev or DeepSeek stop the pass. Never write pages,
 * brain_links or revisions.
 */
export async function runTaskKeeperPhase(
  context: TaskPhaseContext,
): Promise<TaskKeeperResult> {
  const { ownerId, runId, runDate } = context;
  const counts = {
    existing: 0,
    rejected: 0,
    notCommitments: 0,
    alreadyDone: 0,
    droppedFields: 0,
    failedPages: 0,
    /** Over Jev's request limit: pending and reported, the run is partial. */
    oversizedPages: 0,
    /** A new_source waits for a free slot (3 open per task): retried next run. */
    cappedPages: 0,
    /** Hygiene and duplicate proposals waiting for a free slot. */
    cappedSuggestions: 0,
    failedHygiene: 0,
    excludedPages: 0,
    hygieneTasks: 0,
    hygieneReused: 0,
    duplicatePairs: 0,
    expiredSuggestions: 0,
  };
  const result: TaskKeeperResult = {
    status: "succeeded",
    halt: null,
    pagesConsidered: 0,
    pagesScreened: 0,
    unitsReused: 0,
    requests: 0,
    created: 0,
    newSources: 0,
    suggestions: 0,
    occurrences: 0,
    remainingPages: 0,
    spendNano: 0,
  };
  let halt = null as TaskPhaseHalt | null;
  let failures = 0;
  let changed = false;
  /** Returns true when the pass must stop. */
  const track = (step: StepStatus): boolean => {
    result.requests += step.requests;
    if (step.halt) {
      halt = step.halt;
      return true;
    }
    if (step.failed) {
      failures++;
      if (failures >= TASK_KEEPER_LIMITS.providerFailures) {
        halt = "provider";
        return true;
      }
    } else failures = 0;
    return false;
  };

  // Deterministic work first: a budget halt never stops recurrences.
  const recurrences = await keeperRecurrences(ownerId, runDate);
  result.occurrences = recurrences.occurrences;
  const hygiene = await keeperDeterministicHygiene(ownerId);
  result.suggestions += hygiene.opened;
  counts.expiredSuggestions = hygiene.expired;
  changed ||=
    recurrences.occurrences > 0 || hygiene.opened + hygiene.expired > 0;

  const plan = await prepareTaskKeeper(ownerId);
  result.pagesConsidered = plan.pendingPages;
  result.unitsReused = plan.reusedPages;
  counts.excludedPages = plan.excludedPages;
  let processed = 0;

  pages: for (const pageId of plan.pageIds) {
    if (result.created >= TASK_KEEPER_LIMITS.newTasksPerRun) {
      halt = "limit";
      break;
    }
    const screen = await screenKeeperPage(ownerId, runId, pageId);
    const stopScreen = track(screen);
    if (screen.failed) counts.failedPages++;
    if (stopScreen) break;
    if (screen.failed) continue;
    if (screen.status === "oversized") {
      counts.oversizedPages++;
      continue;
    }
    if (screen.status !== "missing" && screen.status !== "excluded")
      result.pagesScreened += screen.status === "reused" ? 0 : 1;
    if (screen.status !== "candidates" || !screen.unitId) {
      processed++;
      continue;
    }
    const extraction = await extractKeeperPage(
      ownerId,
      runId,
      screen.unitId,
      screen.candidates,
    );
    const stopExtraction = track(extraction);
    if (extraction.failed || !extraction.key) counts.failedPages++;
    if (stopExtraction) break;
    if (extraction.failed || !extraction.key) continue;
    const page = { created: 0, newSources: 0, existing: 0, skipped: 0 };
    let complete = true;
    let capped = false;
    for (let index = 0; index < extraction.count; index++) {
      if (result.created >= TASK_KEEPER_LIMITS.newTasksPerRun) {
        halt = "limit";
        complete = false;
        break pages;
      }
      const settled = await settleKeeperItem(
        ownerId,
        runId,
        screen.unitId,
        extraction.key,
        index,
      );
      if (track(settled)) {
        if (settled.failed) counts.failedPages++;
        complete = false;
        break pages;
      }
      if (settled.failed) {
        complete = false;
        continue;
      }
      counts.droppedFields += settled.dropped.length;
      if (settled.outcome === "created") {
        result.created++;
        page.created++;
        changed = true;
      } else if (settled.outcome === "new_source") {
        if (settled.opened) {
          result.newSources++;
          page.newSources++;
          changed = true;
        }
        if (settled.capped) capped = true;
      } else if (settled.outcome === "existing") {
        counts.existing++;
        page.existing++;
      } else {
        page.skipped++;
        if (settled.outcome === "rejected") counts.rejected++;
        if (settled.outcome === "not_commitment") counts.notCommitments++;
        if (settled.outcome === "already_done") counts.alreadyDone++;
      }
    }
    if (!complete) counts.failedPages++;
    // Settling is idempotent: the page is read again once a slot is free.
    else if (capped) counts.cappedPages++;
    else {
      await completeKeeperPage(ownerId, runId, screen.unitId, {
        items: extraction.count,
        ...page,
      });
      processed++;
    }
  }
  result.remainingPages = Math.max(
    0,
    plan.pendingPages - processed - counts.cappedPages,
  );
  if (
    !halt &&
    result.remainingPages > counts.failedPages + counts.oversizedPages
  )
    halt = "limit";

  // Jev hygiene shares the budget: skip it after a budget or provider halt.
  const hygienePlan =
    halt !== "budget" && halt !== "provider"
      ? await prepareKeeperHygiene(ownerId)
      : { taskIds: [], reused: 0, duplicatePairs: [] };
  counts.hygieneReused = hygienePlan.reused;
  if (halt !== "budget" && halt !== "provider") {
    for (const taskId of hygienePlan.taskIds) {
      const step = await keeperTaskHygiene(ownerId, runId, taskId);
      if (step.failed) counts.failedHygiene++;
      if (track(step)) break;
      counts.hygieneTasks++;
      counts.cappedSuggestions += step.capped;
      result.suggestions += step.opened;
      changed ||= step.opened > 0;
    }
  }
  if (halt !== "budget" && halt !== "provider") {
    for (const pair of hygienePlan.duplicatePairs) {
      const step = await keeperDuplicatePair(ownerId, runId, pair.a, pair.b);
      if (step.failed) counts.failedHygiene++;
      if (track(step)) break;
      counts.duplicatePairs++;
      counts.cappedSuggestions += step.capped;
      result.suggestions += step.opened;
      changed ||= step.opened > 0;
    }
  }

  const finish = await finishTaskKeeper(ownerId, runId, changed);
  result.spendNano = finish.spendNano;
  result.halt = halt;
  result.status =
    halt ||
    result.remainingPages ||
    counts.failedPages ||
    counts.oversizedPages ||
    counts.failedHygiene
      ? "partial"
      : "succeeded";
  return { ...result, ...counts };
}
