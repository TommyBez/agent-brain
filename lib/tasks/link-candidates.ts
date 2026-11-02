import type { Database } from "../brain/pages";
import { search } from "../brain/search";
import { getPool } from "../db";
import { POLICY } from "../maintenance/consolidator/types";
import { type GatewayCall, gatewayRequest } from "../maintenance/gateway";
import type { Actor } from "./actors";
import { parseTaskInput } from "./errors";
import { evaluateLinkCandidates } from "./evaluate-link-candidates";
import { TASK_LINK_CANDIDATE_POLICY } from "./link-candidate-policy";
import { readProjectDecisionPageIds } from "./links";
import { resolveProject } from "./page-links";
import {
  type ProjectProposal,
  projectCandidateReads,
  proposeTaskProject,
} from "./project-candidates";
import { loadTaskRow } from "./records";
import { lexicalQuery, planRetrieval } from "./retrieval";
import { suggestTaskLinksSchema } from "./schemas";
import {
  type FallbackReason,
  type SuggestionOptions,
  suggestionBudgetAvailable,
  withinSuggestionDeadline,
} from "./suggestion-control";

export interface PageCandidate {
  pageRef: string;
  slug: string;
  title: string;
  role: "context" | "decision";
  reason: string;
  score: number;
}
export interface CandidateDraft {
  title: string;
  description: string;
  projectPageId: string | null;
}
export interface CandidatePage {
  id: string;
  slug: string;
  title: string;
  markdown: string;
}
export interface CandidateReads {
  decisions(draft: CandidateDraft): Promise<string[]>;
  search(query: string): Promise<{ id: string; slug: string; title: string }[]>;
  pages(refs: string[]): Promise<CandidatePage[]>;
}
/** Dependency boundary exposes only reads. No events, embeddings, spend records or link writes. */
export async function findTaskLinkCandidates(
  draft: CandidateDraft,
  reads: CandidateReads,
  limit = 10,
  send: GatewayCall = gatewayRequest,
  options: SuggestionOptions = {},
): Promise<TaskLinkSuggestionResult> {
  const rules = (await reads.decisions(draft)).slice(
    0,
    TASK_LINK_CANDIDATE_POLICY.maxDecisionCandidates,
  );
  const hits = await reads.search(
    lexicalQuery(`${draft.title} ${draft.description}`),
  );
  const pages = await reads.pages([
    ...new Set([...rules, ...hits.map((hit) => hit.id)]),
  ]);
  const decisions = rules.flatMap((rule) => {
    const page = pages.find((page) => page.id === rule);
    return page ? [page] : [];
  });
  const decisionCandidates: PageCandidate[] = decisions.map((page) => ({
    pageRef: page.id,
    slug: page.slug,
    title: page.title,
    role: "decision",
    reason: "Decision recorded for this project",
    score: 1,
  }));
  const ranked = planRetrieval(hits, [
    draft.projectPageId ?? "",
    ...decisionCandidates.map((item) => item.pageRef),
  ]);
  const textCandidates: PageCandidate[] = [];
  for (const item of ranked) {
    const page = hits.find((hit) => hit.id === item.pageId);
    if (page)
      textCandidates.push({
        pageRef: page.id,
        slug: page.slug,
        title: page.title,
        role: "context",
        reason: "Matches the task title or description",
        score: 1 / (item.rank + 1),
      });
  }
  const candidates: PageCandidate[] = [];
  for (
    let index = 0;
    index < Math.max(decisionCandidates.length, textCandidates.length);
    index++
  ) {
    if (decisionCandidates[index]) candidates.push(decisionCandidates[index]);
    if (textCandidates[index]) candidates.push(textCandidates[index]);
  }
  const evaluated = await evaluateLinkCandidates(
    draft,
    candidates,
    pages,
    send,
    {
      ...options,
      onFallback: (value) =>
        options.onFallback?.({
          ...(value as TaskLinkSuggestion),
          candidates: (value as TaskLinkSuggestion).candidates.slice(0, limit),
        }),
    },
  );
  return {
    ...evaluated,
    candidates: evaluated.candidates.slice(0, Math.min(10, Math.max(1, limit))),
  };
}
export async function suggestTaskLinks(
  actor: Pick<Actor, "ownerId"> & { agentId?: string | null },
  input: unknown,
  send: GatewayCall = gatewayRequest,
): Promise<TaskLinkSuggestionResult> {
  return withinSuggestionDeadline<TaskLinkSuggestionResult>(
    { candidates: [], status: "deterministic", fallbackReason: "deadline" },
    async (signal, fallback) => {
      const data = parseTaskInput(suggestTaskLinksSchema, input);
      const db: Database = getPool();
      let draft: CandidateDraft;
      let authorAgentId = actor.agentId ?? null;
      let includeOwnerRecent = actor.agentId === undefined;
      if (data.ref) {
        const task = await loadTaskRow(db, actor.ownerId, data.ref);
        authorAgentId = task.created_by_agent_id ?? null;
        includeOwnerRecent = false;
        draft = {
          title: task.title,
          description: task.description,
          projectPageId: task.project_page_id,
        };
      } else {
        const project = data.projectRef
          ? await resolveProject(db, actor.ownerId, data.projectRef)
          : null;
        draft = {
          title: data.title ?? "",
          description: data.description ?? "",
          projectPageId: project?.id ?? null,
        };
      }
      if (data.ref && data.projectRef)
        draft.projectPageId = (
          await resolveProject(db, actor.ownerId, data.projectRef)
        ).id;
      signal.throwIfAborted();
      let skipReason: FallbackReason | undefined;
      try {
        if (!(await suggestionBudgetAvailable(db))) skipReason = "budget";
      } catch {
        skipReason = "budget_unavailable";
      }
      const options: SuggestionOptions = {
        signal,
        skipReason,
        onFallback: (value) => fallback(value as TaskLinkSuggestionResult),
      };
      const reads: CandidateReads = {
        decisions: (task) => {
          signal.throwIfAborted();
          return readProjectDecisionPageIds(db, actor.ownerId, task);
        },
        search: async (query) => {
          signal.throwIfAborted();
          return (
            await search(
              actor.ownerId,
              { query, limit: 10, expandGraph: false },
              { serverEmbedding: false },
            )
          ).results;
        },
        pages: async (refs) => {
          signal.throwIfAborted();
          return refs.length
            ? (
                await db.query<CandidatePage>(
                  `SELECT id, slug, title, left(markdown, ${POLICY.maxUnitCharacters}) AS markdown FROM brain_pages WHERE owner_id = $1 AND id::text = ANY($2::text[])`,
                  [actor.ownerId, refs],
                )
              ).rows
            : [];
        },
      };
      if (!draft.projectPageId) {
        const hits = await reads.search(
          lexicalQuery(`${draft.title} ${draft.description}`),
        );
        signal.throwIfAborted();
        const projectProposal = await proposeTaskProject(
          draft,
          hits.map((page) => page.id),
          projectCandidateReads(
            db,
            actor.ownerId,
            authorAgentId,
            includeOwnerRecent,
          ),
          send,
          {
            ...options,
            onFallback: (value) =>
              fallback({
                candidates: [],
                status: "deterministic",
                fallbackReason: "deadline",
                projectProposal: value as ProjectProposal,
              }),
          },
        );
        return {
          candidates: [],
          status: projectProposal.status,
          ...(projectProposal.fallbackReason
            ? { fallbackReason: projectProposal.fallbackReason }
            : {}),
          projectProposal,
        };
      }
      return findTaskLinkCandidates(draft, reads, data.limit, send, options);
    },
  );
}

export interface TaskLinkSuggestion {
  /** Additive field: legacy client snapshots may omit it; current endpoint never does. */
  status?: "evaluated" | "deterministic";
  fallbackReason?: FallbackReason;
  unevaluatedPageRefs?: string[];
  candidates: PageCandidate[];
  projectProposal?: ProjectProposal;
}

/** Server responses always carry the new status while old client snapshots remain valid. */
export type TaskLinkSuggestionResult = TaskLinkSuggestion & {
  status: "evaluated" | "deterministic";
};
