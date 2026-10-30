import { fingerprint } from "../../canonical-json";
import { TASK_LINK_POLICY } from "./policy";

// Deterministic candidate selection and LinkUnit identity (§8.3 steps 2–3).

export type CandidateSource =
  | "decided_in"
  | "neighbor"
  | "retrieval"
  | "resolve";

export interface CandidateRef {
  pageId: string;
  source: CandidateSource;
  /** Matched passage of a retrieval hit, when search returned one. */
  passage?: { startOffset: number; endOffset: number; content: string };
}

export interface CandidateInputs {
  /** decided_in decisions of the project first, then 1-hop part_of/depends_on pages. */
  neighborhood: CandidateRef[];
  retrieval: CandidateRef[];
  resolved: CandidateRef[];
  /** Pages with an active or rejected link for the task, and its project. */
  excluded: Iterable<string>;
}

/**
 * At most 12 unique candidates in a fixed order: (a) the project's decision
 * neighbourhood (≤4), (b) search results, (c) resolved title names (≤2). The
 * name slots are reserved before search fills the rest.
 */
export function selectCandidates(inputs: CandidateInputs): CandidateRef[] {
  const taken = new Set(inputs.excluded);
  const pick = (refs: CandidateRef[], limit: number) => {
    const chosen: CandidateRef[] = [];
    for (const ref of refs) {
      if (chosen.length >= limit) break;
      if (taken.has(ref.pageId)) continue;
      taken.add(ref.pageId);
      chosen.push(ref);
    }
    return chosen;
  };
  const neighborhood = pick(inputs.neighborhood, TASK_LINK_POLICY.neighborhood);
  const resolved = pick(inputs.resolved, TASK_LINK_POLICY.resolved);
  const retrieval = pick(
    inputs.retrieval,
    TASK_LINK_POLICY.maxCandidates - neighborhood.length - resolved.length,
  );
  return [...neighborhood, ...retrieval, ...resolved];
}

export interface EvidencePageInput {
  id: string;
  slug: string;
  type: string;
  title: string;
  summary: string;
  markdown: string;
  relationships: string[];
  aliases: string[];
  tags: string[];
  links: { targetId: string; type: string; label: string }[];
}

/** Source-owned semantic content of a page, as in the consolidator's projections. */
export function pageEvidenceFingerprint(page: EvidencePageInput): string {
  return fingerprint({
    id: page.id,
    slug: page.slug,
    type: page.type,
    title: page.title,
    summary: page.summary,
    markdown: page.markdown,
    relationships: page.relationships,
    aliases: page.aliases,
    tags: page.tags,
    links: [...page.links].sort(
      (a, b) =>
        a.targetId.localeCompare(b.targetId) || a.type.localeCompare(b.type),
    ),
  });
}

/**
 * LinkUnit.id: policy, the task, its semantics and the candidates' evidence, in
 * order. The task id keeps two tasks with the same text (recurrence instances)
 * on separate analyses and receipts; the shared `evaluation:` cache, keyed by
 * the request, still answers them with one Jev request.
 */
export function linkUnitId(input: {
  taskId: string;
  taskFingerprint: string;
  candidateFingerprints: string[];
  policyVersion?: string;
}): string {
  return fingerprint({
    policy: input.policyVersion ?? TASK_LINK_POLICY.version,
    taskId: input.taskId,
    task: input.taskFingerprint,
    candidates: input.candidateFingerprints,
  });
}

export const taskLinkKeys = {
  analysis: (unitId: string) => `task-link:analysis:${unitId}` as const,
  /** Per Workflow run: a replay is a no-op, a later run plans again. */
  apply: (unitId: string, runId: string) =>
    `task-link:apply:${unitId}:${runId}` as const,
  /** The inputs a task's Jev pass last completed for. */
  inputs: (taskId: string) => `task-link:inputs:${taskId}` as const,
};

/**
 * What a task's LinkUnit depends on besides its candidates' content: policy,
 * task semantics, the corpus and whether a current task vector drove search.
 */
export function linkInputsFingerprint(input: {
  policyVersion?: string;
  taskFingerprint: string;
  corpus: string;
  vectorModel: string | null;
}): string {
  return fingerprint({
    policy: input.policyVersion ?? TASK_LINK_POLICY.version,
    task: input.taskFingerprint,
    corpus: input.corpus,
    vector: input.vectorModel,
  });
}

/** A task's last completed Jev pass: its inputs and when they last changed. */
export interface CompletedPass {
  inputs: string;
  /** Epoch milliseconds. */
  at: number;
}

/**
 * The run's Jev queue. Tasks whose inputs changed since their last completed
 * pass come first: all of them when they fit, else the never or least
 * recently completed ones, so the cap rotates through every task even when
 * the corpus changes each night. The chosen ones keep queue order; tasks
 * already analysed for their current inputs fill the remaining slots.
 */
export function jevQueue(
  tasks: { id: string; inputs: string }[],
  completed: Map<string, CompletedPass>,
  limit: number = TASK_LINK_POLICY.maxTasksPerRun,
): { taskIds: string[]; remainingTasks: number } {
  const current = (task: { id: string; inputs: string }) =>
    completed.get(task.id)?.inputs === task.inputs;
  const stale = tasks.filter((task) => !current(task));
  const chosen = new Set(
    [...stale]
      .sort(
        (a, b) =>
          (completed.get(a.id)?.at ?? -1) - (completed.get(b.id)?.at ?? -1),
      )
      .slice(0, limit)
      .map((task) => task.id),
  );
  return {
    taskIds: [
      ...stale.filter((task) => chosen.has(task.id)),
      ...tasks.filter(current),
    ]
      .slice(0, limit)
      .map((task) => task.id),
    remainingTasks: stale.length - chosen.size,
  };
}

export interface Excerpt {
  text: string;
  startOffset: number;
  endOffset: number;
}

/** A bounded passage: the matched one when valid, else the page opening. */
export function excerptFor(
  markdown: string,
  passage?: { startOffset: number; endOffset: number } | null,
): Excerpt {
  const limit = TASK_LINK_POLICY.excerptCharacters;
  if (
    passage &&
    passage.endOffset > passage.startOffset &&
    passage.endOffset <= markdown.length
  ) {
    const endOffset = Math.min(passage.endOffset, passage.startOffset + limit);
    return {
      text: markdown.slice(passage.startOffset, endOffset),
      startOffset: passage.startOffset,
      endOffset,
    };
  }
  const endOffset = Math.min(markdown.length, limit);
  return { text: markdown.slice(0, endOffset), startOffset: 0, endOffset };
}

/** Capitalized names in a title, skipping its first word (a verb in most titles). */
export function titleNames(title: string, limit = 3): string[] {
  const words = title.split(/\s+/).filter(Boolean);
  const names: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) names.push(current.join(" "));
    current = [];
  };
  words.forEach((raw, index) => {
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    const capitalized = /^\p{Lu}[\p{L}\p{N}'’.&-]*$/u.test(word);
    if (capitalized && (index > 0 || /^\p{Lu}{2,}/u.test(word)))
      current.push(word);
    else flush();
    if (/[,;:()]$/.test(raw)) flush();
  });
  flush();
  return [...new Set(names.filter((name) => name.length >= 2))].slice(0, limit);
}
