import { loadPages } from "../../brain/pages";
import type { BrainPage } from "../../brain/types";
import { fingerprint } from "../../canonical-json";
import { getPool } from "../../db";
import {
  formatTaskRef,
  type TaskSuggestionKind,
  TERMINAL_TASK_STATUSES,
} from "../../tasks/types";
import { pageEvidenceFingerprint } from "../consolidator/snapshot";
import { findConsolidationRecords } from "../consolidator/store";
import type { Evaluate, Question } from "../consolidator/types";
import { normalizeForFingerprint } from "./dedupe";
import { TASK_KEEPER_LIMITS, TASK_KEEPER_THRESHOLDS } from "./policy";
import { keeperQuestion, TASK_KEEPER_POLICY } from "./prompts";
import { askAll, probability } from "./screen";
import {
  keeperKeys,
  openSuggestion,
  type SuggestionCitation,
  type SuggestionInput,
  tasksAtSuggestionCap,
} from "./store";

// Hygiene suggestions (§8.5). Deterministic ones come from task state alone;
// Jev ones read the task's active linked pages. Nothing is ever applied: the
// owner accepts a suggestion and runs its prefilled transition in the app.

const TERMINAL = TERMINAL_TASK_STATUSES as readonly string[];
const ZONE = "Europe/Rome";
export const DETERMINISTIC_KINDS = [
  "overdue_no_outcome",
  "stale_claim",
  "triage_aging",
  "decision_superseded",
] as const satisfies readonly TaskSuggestionKind[];

type Proposal = Omit<SuggestionInput, "ownerId" | "createdByAgentId">;

/** When task `t` last entered triage (its creation, or a return to it). */
export const TRIAGE_ENTERED = `COALESCE((SELECT max(e.created_at) FROM brain_task_events e
  WHERE e.owner_id = t.owner_id AND e.task_id = t.id AND e.to_status = 'triage'), t.created_at)`;

/** Deterministic proposals for the owner's open tasks, from SQL only. */
export async function deterministicProposals(
  ownerId: string,
): Promise<Proposal[]> {
  const db = getPool();
  const proposals: Proposal[] = [];
  const overdue = await db.query(
    `SELECT t.id, t.number, to_char(d.due_date, 'YYYY-MM-DD') AS due_date
     FROM brain_tasks t
     CROSS JOIN LATERAL (SELECT COALESCE(t.due_on, (t.due_at AT TIME ZONE $3)::date) AS due_date) d
     WHERE t.owner_id = $1 AND t.archived_at IS NULL
       AND t.status <> ALL($2::text[]) AND t.status <> 'on_hold'
       AND d.due_date < (now() AT TIME ZONE $3)::date - $4::int
       AND NOT EXISTS (
         SELECT 1 FROM brain_task_events e
         WHERE e.owner_id = t.owner_id AND e.task_id = t.id
           AND e.created_at >= ((d.due_date + 1)::timestamp AT TIME ZONE $3)
           -- Machine bookkeeping (link upkeep, keeper parties) is no outcome.
           AND e.action <> 'links_changed'
           AND NOT EXISTS (
             SELECT 1 FROM brain_agents a
             WHERE a.owner_id = e.owner_id AND a.id = e.actor_agent_id AND a.kind = 'system'))
     ORDER BY t.number`,
    [ownerId, TERMINAL, ZONE, TASK_KEEPER_LIMITS.overdueDays],
  );
  for (const row of overdue.rows)
    proposals.push({
      taskId: row.id,
      kind: "overdue_no_outcome",
      citations: [],
      dedupeKey: `overdue_no_outcome:${row.id}:${row.due_date}`,
      payload: {
        action: "review_due",
        options: ["reschedule", "close", "cancel"],
        dueDate: row.due_date,
      },
    });
  // Each lease expiry is its own episode: a lease renewed by a report and
  // expired again gets a new key.
  const stale = await db.query(
    `SELECT t.id, t.claimed_by_agent_id,
       to_char(t.lease_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS expired_at
     FROM brain_tasks t
     WHERE t.owner_id = $1 AND t.archived_at IS NULL AND t.status = 'in_progress'
       AND t.lease_id IS NOT NULL AND t.lease_expires_at < now()
     ORDER BY t.number`,
    [ownerId],
  );
  for (const row of stale.rows)
    proposals.push({
      taskId: row.id,
      kind: "stale_claim",
      citations: [],
      dedupeKey: `stale_claim:${row.id}:${row.expired_at}`,
      payload: {
        action: "force_release",
        holderAgentId: row.claimed_by_agent_id,
        leaseExpiredAt: row.expired_at,
      },
    });
  // Aging counts from the last entry into triage; each entry is an episode.
  const triage = await db.query(
    `SELECT t.id, to_char(${TRIAGE_ENTERED} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS entered
     FROM brain_tasks t
     WHERE t.owner_id = $1 AND t.archived_at IS NULL AND t.status = 'triage'
       AND ${TRIAGE_ENTERED} < now() - make_interval(days => $2::int)
     ORDER BY t.number`,
    [ownerId, TASK_KEEPER_LIMITS.triageAgingDays],
  );
  for (const row of triage.rows)
    proposals.push({
      taskId: row.id,
      kind: "triage_aging",
      citations: [],
      dedupeKey: `triage_aging:${row.id}:${row.entered}`,
      payload: { action: "approve_or_cancel" },
    });
  const superseded = await db.query(
    `SELECT DISTINCT l.task_id, d.id AS decision_id, d.slug AS decision_slug, d.title AS decision_title,
       d.version AS decision_version, s.id AS source_id, s.slug AS source_slug, s.title AS source_title,
       s.version AS source_version
     FROM brain_task_links l
     JOIN brain_tasks t ON t.owner_id = l.owner_id AND t.id = l.task_id
     JOIN brain_pages d ON d.owner_id = l.owner_id AND d.id = l.page_id AND d.type = 'decision'
     JOIN brain_links bl ON bl.owner_id = d.owner_id AND bl.target_id = d.id AND bl.type = 'supersedes'
     JOIN brain_pages s ON s.owner_id = bl.owner_id AND s.id = bl.source_id
     WHERE l.owner_id = $1 AND l.status = 'active' AND t.archived_at IS NULL
       AND t.status <> ALL($2::text[])
     ORDER BY l.task_id, d.id, s.id`,
    [ownerId, TERMINAL],
  );
  for (const row of superseded.rows)
    proposals.push({
      taskId: row.task_id,
      kind: "decision_superseded",
      citations: [
        {
          pageId: row.source_id,
          slug: row.source_slug,
          title: row.source_title,
          pageVersion: row.source_version,
        },
        {
          pageId: row.decision_id,
          slug: row.decision_slug,
          title: row.decision_title,
          pageVersion: row.decision_version,
        },
      ],
      dedupeKey: `decision_superseded:${row.task_id}:${row.decision_id}:${row.source_id}`,
      payload: {
        action: "review_decision_links",
        supersededPageId: row.decision_id,
        supersedingPageId: row.source_id,
      },
    });
  return proposals;
}

/**
 * Opens current deterministic proposals and expires open ones whose condition
 * no longer holds. Keys carry the episode (due date, lease expiry, entry into
 * triage), so a later recurrence of the condition gets a new key.
 */
export async function runDeterministicHygiene(
  ownerId: string,
  agentId: string,
): Promise<{ opened: number; expired: number }> {
  const proposals = await deterministicProposals(ownerId);
  const db = getPool();
  const expired = await db.query(
    `UPDATE brain_task_suggestions s SET status = 'expired', updated_at = now()
     FROM brain_tasks t
     WHERE s.owner_id = $1 AND s.status = 'open' AND t.owner_id = s.owner_id AND t.id = s.task_id
       AND (
         (s.kind = ANY($2::text[]) AND s.kind <> 'decision_superseded' AND NOT (s.dedupe_key = ANY($3::text[])))
         OR (s.kind <> 'new_source' AND (t.status = ANY($4::text[]) OR t.archived_at IS NOT NULL))
       )`,
    [
      ownerId,
      DETERMINISTIC_KINDS,
      proposals.map((proposal) => proposal.dedupeKey),
      TERMINAL,
    ],
  );
  let opened = 0;
  for (const proposal of proposals)
    if (
      (await openSuggestion(db, {
        ...proposal,
        ownerId,
        createdByAgentId: agentId,
      })) === "opened"
    )
      opened++;
  return { opened, expired: expired.rowCount ?? 0 };
}

// ---------------------------------------------------------------------------
// Jev hygiene over linked pages

export interface HygieneTask {
  id: string;
  number: number;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  projectPageId: string | null;
  /** Active linked pages, most recently updated first, exclusions removed. */
  pageIds: string[];
}

/** The work's identity for reuse; status, leases and parties are excluded. */
export function taskSemanticFingerprint(task: {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  projectPageId: string | null;
}): string {
  return fingerprint({
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    projectId: task.projectPageId,
  });
}

/**
 * Per task: two tasks with the same text and pages (recurrence instances) are
 * judged separately; the request carries no ids, so the `evaluation:` cache
 * answers the second at no cost.
 */
export function hygieneUnitId(
  task: HygieneTask,
  pageFingerprints: Map<string, string>,
): string {
  return fingerprint({
    policy: TASK_KEEPER_POLICY.version,
    taskId: task.id,
    task: taskSemanticFingerprint(task),
    pages: task.pageIds.map((id) => [id, pageFingerprints.get(id) ?? null]),
  });
}

/** Open tasks with active links to pages outside the exclusions. */
export async function listHygieneTasks(
  ownerId: string,
  excluded: string[],
  ids: string[] | null = null,
): Promise<HygieneTask[]> {
  const { rows } = await getPool().query(
    `SELECT t.id, t.number, t.title, t.description, t.acceptance_criteria, t.project_page_id,
       array_agg(l.page_id ORDER BY p.updated_at DESC, p.id) AS page_ids
     FROM brain_tasks t
     JOIN brain_task_links l ON l.owner_id = t.owner_id AND l.task_id = t.id AND l.status = 'active'
     JOIN brain_pages p ON p.owner_id = l.owner_id AND p.id = l.page_id
     WHERE t.owner_id = $1 AND t.archived_at IS NULL AND t.status <> ALL($2::text[])
       AND NOT (l.page_id = ANY($3::uuid[]))
       AND ($4::uuid[] IS NULL OR t.id = ANY($4::uuid[]))
     GROUP BY t.id ORDER BY t.number`,
    [ownerId, TERMINAL, excluded, ids],
  );
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptance_criteria,
    projectPageId: row.project_page_id,
    pageIds: [...new Set(row.page_ids as string[])].slice(
      0,
      TASK_KEEPER_LIMITS.linkedPagesPerTask,
    ),
  }));
}

export async function loadHygieneTask(
  ownerId: string,
  taskId: string,
  excluded: string[],
): Promise<HygieneTask | null> {
  return (await listHygieneTasks(ownerId, excluded, [taskId]))[0] ?? null;
}

type PageState = "done" | "canceled" | "moved";
const PAGE_STATES: PageState[] = ["done", "canceled", "moved"];

/** One request per task: per page done/canceled/moved, per criterion, divergence. */
export function hygieneRequest(task: HygieneTask, pages: BrainPage[]) {
  const criteria = task.acceptanceCriteria.slice(
    0,
    TASK_KEEPER_LIMITS.criteriaPerTask,
  );
  const state = {
    task: {
      title: task.title,
      description: task.description.slice(0, 3000),
      acceptanceCriteria: criteria,
    },
    pages: Object.fromEntries(
      pages.map((page, index) => [
        `p${index}`,
        {
          title: page.title,
          type: page.type,
          summary: page.summary,
          markdown: page.markdown.slice(
            0,
            TASK_KEEPER_LIMITS.hygienePageCharacters,
          ),
        },
      ]),
    ),
  };
  const questions: Record<string, Question> = {};
  pages.forEach((_, index) => {
    for (const kind of PAGE_STATES)
      questions[`${kind}_p${index}`] = keeperQuestion(kind, {
        key: `p${index}`,
      });
  });
  if (pages.length)
    criteria.forEach((_, index) => {
      questions[`criterion_${index}`] = keeperQuestion("criterion", {
        index: String(index),
      });
    });
  if (pages.length >= 2) questions.divergent = keeperQuestion("divergent");
  return { state, questions, criteria };
}

function citation(page: BrainPage): SuggestionCitation {
  return {
    pageId: page.id,
    slug: page.slug,
    title: page.title,
    pageVersion: page.version,
  };
}

/** Suggestions from one task's hygiene answers. Pure. */
export function hygieneProposals(
  task: HygieneTask,
  pages: BrainPage[],
  answers: Record<string, number>,
  criteria: string[],
): Proposal[] {
  const proposals: Proposal[] = [];
  const t = TASK_KEEPER_THRESHOLDS;
  pages.forEach((page, index) => {
    const best = PAGE_STATES.map((kind) => ({
      kind,
      value: answers[`${kind}_p${index}`] ?? 0,
    })).sort((a, b) => b.value - a.value)[0];
    if (best && best.value >= t.mayBeDone)
      proposals.push({
        taskId: task.id,
        kind: "may_be_done",
        citations: [citation(page)],
        confidence: best.value,
        dedupeKey: `may_be_done:${task.id}:${page.id}:${best.kind}`,
        payload: {
          action:
            best.kind === "done"
              ? "close"
              : best.kind === "canceled"
                ? "cancel"
                : "reschedule",
          state: best.kind,
          pageId: page.id,
          pageVersion: page.version,
        },
      });
  });
  criteria.forEach((criterion, index) => {
    const value = answers[`criterion_${index}`] ?? 0;
    if (value >= t.criterionEvidence)
      proposals.push({
        taskId: task.id,
        kind: "criterion_evidence",
        citations: pages.map(citation),
        confidence: value,
        dedupeKey: `criterion_evidence:${task.id}:${fingerprint(normalizeForFingerprint(criterion)).slice(0, 16)}`,
        payload: {
          action: "review_criterion",
          criterionIndex: index,
          criterion,
        },
      });
  });
  const divergent = answers.divergent ?? 0;
  if (pages.length >= 2 && divergent >= t.divergentState)
    proposals.push({
      taskId: task.id,
      kind: "divergent_state",
      citations: pages.map(citation),
      confidence: divergent,
      dedupeKey: `divergent_state:${task.id}:${fingerprint(pages.map((page) => page.id).sort()).slice(0, 16)}`,
      // Lists the sources without choosing one.
      payload: {
        action: "review_sources",
        sources: pages.map((page) => ({
          pageId: page.id,
          pageVersion: page.version,
        })),
      },
    });
  return proposals;
}

/**
 * Evaluates one task's linked pages and opens its suggestions. `capped`
 * counts proposals refused only by the 3-open cap: the unit stays pending.
 */
export async function evaluateTaskHygiene(
  ownerId: string,
  task: HygieneTask,
  evaluate: Evaluate,
  agentId: string,
): Promise<{ opened: number; capped: number; unitId: string }> {
  const db = getPool();
  const pages = (await loadPages(db, ownerId, task.pageIds)).sort(
    (a, b) => task.pageIds.indexOf(a.id) - task.pageIds.indexOf(b.id),
  );
  const fingerprints = new Map(
    pages.map((page) => [page.id, pageEvidenceFingerprint(page)]),
  );
  const unitId = hygieneUnitId(task, fingerprints);
  if (!pages.length) return { opened: 0, capped: 0, unitId };
  const request = hygieneRequest(task, pages);
  const answers = await askAll(request.state, request.questions, evaluate);
  const values = Object.fromEntries(
    Object.keys(request.questions).map((id) => [id, probability(answers[id])]),
  );
  let opened = 0;
  let capped = 0;
  for (const proposal of hygieneProposals(
    task,
    pages,
    values,
    request.criteria,
  )) {
    const outcome = await openSuggestion(db, {
      ...proposal,
      ownerId,
      createdByAgentId: agentId,
    });
    if (outcome === "opened") opened++;
    if (outcome === "capped") capped++;
  }
  return { opened, capped, unitId };
}

// ---------------------------------------------------------------------------
// Duplicates among open tasks

export interface DuplicatePair {
  a: HygieneTask;
  b: HygieneTask;
}

/** Per pair of tasks, like hygieneUnitId; the cached request carries no ids. */
export function duplicateUnitId(pair: DuplicatePair): string {
  return fingerprint({
    policy: TASK_KEEPER_POLICY.version,
    aId: pair.a.id,
    bId: pair.b.id,
    a: taskSemanticFingerprint(pair.a),
    b: taskSemanticFingerprint(pair.b),
  });
}

export const DUPLICATE_PAIR_PAGE = 100;

/**
 * Candidate pairs: pg_trgm ≥0.55 or vector distance <0.15, older task first,
 * one page after the (a, b) numbers `after`.
 */
export async function listDuplicatePairs(
  ownerId: string,
  {
    limit = DUPLICATE_PAIR_PAGE,
    after = null,
  }: { limit?: number; after?: { a: number; b: number } | null } = {},
): Promise<DuplicatePair[]> {
  const { rows } = await getPool().query(
    `SELECT a.id AS a_id, a.number AS a_number, a.title AS a_title, a.description AS a_description,
       a.acceptance_criteria AS a_criteria, a.project_page_id AS a_project,
       b.id AS b_id, b.number AS b_number, b.title AS b_title, b.description AS b_description,
       b.acceptance_criteria AS b_criteria, b.project_page_id AS b_project
     FROM brain_tasks a
     JOIN brain_tasks b ON b.owner_id = a.owner_id AND a.number < b.number
     WHERE a.owner_id = $1 AND a.archived_at IS NULL AND b.archived_at IS NULL
       AND a.status <> ALL($2::text[]) AND b.status <> ALL($2::text[])
       AND (a.recurrence_id IS NULL OR a.recurrence_id IS DISTINCT FROM b.recurrence_id)
       AND (similarity(a.title, b.title) >= $3
         OR (a.embedding IS NOT NULL AND b.embedding IS NOT NULL
             AND a.embedding_model = b.embedding_model AND (a.embedding <=> b.embedding) < $4))
       AND NOT EXISTS (SELECT 1 FROM brain_task_suggestions s
         WHERE s.owner_id = a.owner_id AND s.dedupe_key = 'duplicate:' || a.id || ':' || b.id)
       AND ($6::int IS NULL OR (a.number, b.number) > ($6::int, $7::int))
     ORDER BY a.number, b.number LIMIT $5`,
    [
      ownerId,
      TERMINAL,
      TASK_KEEPER_THRESHOLDS.duplicateTitleSimilarity,
      TASK_KEEPER_THRESHOLDS.duplicateVectorDistance,
      limit,
      after?.a ?? null,
      after?.b ?? null,
    ],
  );
  const task = (
    row: Record<string, unknown>,
    side: "a" | "b",
  ): HygieneTask => ({
    id: row[`${side}_id`] as string,
    number: row[`${side}_number`] as number,
    title: row[`${side}_title`] as string,
    description: row[`${side}_description`] as string,
    acceptanceCriteria: row[`${side}_criteria`] as string[],
    projectPageId: row[`${side}_project`] as string | null,
    pageIds: [],
  });
  return rows.map((row) => ({ a: task(row, "a"), b: task(row, "b") }));
}

/**
 * Up to `limit` candidate pairs without a judgment for their current unit.
 * Judged pairs are skipped page by page, so they never crowd out newer pairs;
 * pairs whose suggestion would wait for a free slot on the newer task come
 * after the others.
 */
export async function pendingDuplicatePairs(
  ownerId: string,
  limit: number = TASK_KEEPER_LIMITS.duplicatePairsPerRun,
): Promise<DuplicatePair[]> {
  const full = await tasksAtSuggestionCap(ownerId);
  const pending: DuplicatePair[] = [];
  const waiting: DuplicatePair[] = [];
  let after: { a: number; b: number } | null = null;
  while (pending.length < limit) {
    const page = await listDuplicatePairs(ownerId, { after });
    const judged = await findConsolidationRecords(
      ownerId,
      page.map((pair) => keeperKeys.duplicate(duplicateUnitId(pair))),
    );
    for (const pair of page) {
      if (judged.has(keeperKeys.duplicate(duplicateUnitId(pair)))) continue;
      const queue = full.has(pair.b.id) ? waiting : pending;
      if (queue.length < limit) queue.push(pair);
    }
    if (page.length < DUPLICATE_PAIR_PAGE) break;
    const last = page[page.length - 1];
    after = { a: last.a.number, b: last.b.number };
  }
  return [...pending, ...waiting].slice(0, limit);
}

/** `capped`: a duplicate refused only by the 3-open cap; the pair stays pending. */
export async function evaluateDuplicatePair(
  ownerId: string,
  pair: DuplicatePair,
  evaluate: Evaluate,
  agentId: string,
): Promise<{ opened: boolean; capped: boolean; probability: number }> {
  const view = (task: HygieneTask) => ({
    title: task.title,
    description: task.description.slice(0, 1500),
    acceptanceCriteria: task.acceptanceCriteria.slice(0, 10),
  });
  const answers = await askAll(
    { tasks: { a: view(pair.a), b: view(pair.b) } },
    { same_work: keeperQuestion("same_work") },
    evaluate,
  );
  const value = probability(answers.same_work);
  if (value < TASK_KEEPER_THRESHOLDS.duplicate)
    return { opened: false, capped: false, probability: value };
  const outcome = await openSuggestion(getPool(), {
    ownerId,
    taskId: pair.b.id,
    relatedTaskId: pair.a.id,
    kind: "duplicate",
    citations: [
      { taskId: pair.a.id, ref: formatTaskRef(pair.a.number) },
      { taskId: pair.b.id, ref: formatTaskRef(pair.b.number) },
    ],
    confidence: value,
    dedupeKey: `duplicate:${pair.a.id}:${pair.b.id}`,
    payload: {
      action: "merge",
      keepRef: formatTaskRef(pair.a.number),
      mergeRef: formatTaskRef(pair.b.number),
    },
    createdByAgentId: agentId,
  });
  return {
    opened: outcome === "opened",
    capped: outcome === "capped",
    probability: value,
  };
}

/** Both tasks, still open and unarchived, or null. */
export async function loadDuplicatePair(
  ownerId: string,
  aId: string,
  bId: string,
): Promise<DuplicatePair | null> {
  const { rows } = await getPool().query(
    `SELECT id, number, title, description, acceptance_criteria, project_page_id
     FROM brain_tasks
     WHERE owner_id = $1 AND id = ANY($2::uuid[]) AND archived_at IS NULL
       AND status <> ALL($3::text[])`,
    [ownerId, [aId, bId], TERMINAL],
  );
  const task = (id: string): HygieneTask | null => {
    const row = rows.find((candidate) => candidate.id === id);
    return row
      ? {
          id: row.id,
          number: row.number,
          title: row.title,
          description: row.description,
          acceptanceCriteria: row.acceptance_criteria,
          projectPageId: row.project_page_id,
          pageIds: [],
        }
      : null;
  };
  const a = task(aId);
  const b = task(bId);
  return a && b ? { a, b } : null;
}
