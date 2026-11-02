import type { Database } from "../brain/pages";
import { search } from "../brain/search";
import { getPool } from "../db";
import type { Actor } from "./actors";
import { parseTaskInput } from "./errors";
import { desiredRuleLinks } from "./links";
import { resolvePages, resolveProject } from "./page-links";
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
export interface CandidateReads {
  decisions(draft: CandidateDraft): Promise<{ pageId: string }[]>;
  search(query: string): Promise<{ id: string; slug: string; title: string }[]>;
  pages(refs: string[]): Promise<{ id: string; slug: string; title: string }[]>;
}
/** Dependency boundary exposes only reads. No events, embeddings, spend or link writes. */
export async function findTaskLinkCandidates(
  draft: CandidateDraft,
  reads: CandidateReads,
  limit = 10,
): Promise<{ candidates: PageCandidate[] }> {
  const rules = await reads.decisions(draft);
  const hits = await reads.search(
    lexicalQuery(`${draft.title} ${draft.description}`),
  );
  const decisions = rules.length
    ? await reads.pages(rules.map((rule) => rule.pageId))
    : [];
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
  return { candidates: candidates.slice(0, Math.min(10, Math.max(1, limit))) };
}
export async function suggestTaskLinks(actor: Actor, input: unknown) {
  const data = parseTaskInput(suggestTaskLinksSchema, input);
  const db: Database = getPool();
  let draft: CandidateDraft;
  if (data.ref) {
    const task = await loadTaskRow(db, actor.ownerId, data.ref);
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
  return findTaskLinkCandidates(
    draft,
    {
      decisions: (task) => desiredRuleLinks(db, actor.ownerId, task),
      search: async (query) =>
        (
          await search(
            actor.ownerId,
            { query, limit: 10, expandGraph: false },
            { serverEmbedding: false },
          )
        ).results,
      pages: (refs) => resolvePages(db, actor.ownerId, refs),
    },
    data.limit,
  );
}
