import type { Database } from "../brain/pages";
import { search } from "../brain/search";
import { getPool } from "../db";
import { type GatewayCall, gatewayRequest } from "../maintenance/gateway";
import type { Actor } from "./actors";
import { parseTaskInput } from "./errors";
import { evaluateLinkCandidates } from "./evaluate-link-candidates";
import { desiredRuleLinks } from "./links";
import { resolveProject } from "./page-links";
import {
  type ProjectProposal,
  projectCandidateReads,
  proposeTaskProject,
} from "./project-candidates";
import { loadTaskRow } from "./records";
import { lexicalQuery, planRetrieval } from "./retrieval";
import { suggestTaskLinksSchema } from "./schemas";

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
  decisions(draft: CandidateDraft): Promise<{ pageId: string }[]>;
  search(query: string): Promise<{ id: string; slug: string; title: string }[]>;
  pages(refs: string[]): Promise<CandidatePage[]>;
}
/** Dependency boundary exposes only reads. No events, embeddings, spend records or link writes. */
export async function findTaskLinkCandidates(
  draft: CandidateDraft,
  reads: CandidateReads,
  limit = 10,
  send: GatewayCall = gatewayRequest,
): Promise<{ candidates: PageCandidate[] }> {
  const rules = await reads.decisions(draft);
  const hits = await reads.search(
    lexicalQuery(`${draft.title} ${draft.description}`),
  );
  const pages = await reads.pages([
    ...new Set([
      ...rules.map((rule) => rule.pageId),
      ...hits.map((hit) => hit.id),
    ]),
  ]);
  const decisions = rules.flatMap((rule) => {
    const page = pages.find((page) => page.id === rule.pageId);
    return page ? [page] : [];
  });
  const candidates: PageCandidate[] = decisions.map((page) => ({
    pageRef: page.id,
    slug: page.slug,
    title: page.title,
    role: "decision",
    reason: "Decision recorded for this project",
    score: 1,
  }));
  const ranked = planRetrieval(hits, [
    draft.projectPageId ?? "",
    ...candidates.map((item) => item.pageRef),
  ]);
  for (const item of ranked) {
    const page = hits.find((hit) => hit.id === item.pageId);
    if (page)
      candidates.push({
        pageRef: page.id,
        slug: page.slug,
        title: page.title,
        role: "context",
        reason: "Matches the task title or description",
        score: 1 / (item.rank + 1),
      });
  }
  const evaluated = await evaluateLinkCandidates(
    draft,
    candidates,
    pages,
    send,
  );
  return { candidates: evaluated.slice(0, Math.min(10, Math.max(1, limit))) };
}
export async function suggestTaskLinks(
  actor: Pick<Actor, "ownerId"> & { agentId?: string | null },
  input: unknown,
  send: GatewayCall = gatewayRequest,
): Promise<TaskLinkSuggestion> {
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
  const reads: CandidateReads = {
    decisions: (task) => desiredRuleLinks(db, actor.ownerId, task),
    search: async (query) =>
      (
        await search(
          actor.ownerId,
          { query, limit: 10, expandGraph: false },
          { serverEmbedding: false },
        )
      ).results,
    pages: async (refs) =>
      refs.length
        ? (
            await db.query<CandidatePage>(
              "SELECT id, slug, title, markdown FROM brain_pages WHERE owner_id = $1 AND id::text = ANY($2::text[])",
              [actor.ownerId, refs],
            )
          ).rows
        : [],
  };
  if (!draft.projectPageId) {
    const hits = await reads.search(
      lexicalQuery(`${draft.title} ${draft.description}`),
    );
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
    );
    return { candidates: [], projectProposal };
  }
  return findTaskLinkCandidates(draft, reads, data.limit, send);
}

export interface TaskLinkSuggestion {
  candidates: PageCandidate[];
  projectProposal?: ProjectProposal;
}
