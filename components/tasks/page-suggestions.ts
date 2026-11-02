import type {
  PageCandidate,
  TaskLinkSuggestion,
} from "@/lib/tasks/link-candidates";

/** Pages a task form links on Save/Create; matches the contextPageRefs limit. */
export const CONFIRMED_PAGE_LIMIT = 10;

export type SuggestionDraft = { title: string; description: string };

/** A suggested page the owner confirmed, held by the form until Save/Create. */
export interface ConfirmedPage {
  pageRef: string;
  slug: string;
  title: string;
  role: PageCandidate["role"];
  /** The project the suggestion was computed for. */
  projectRef: string | null;
}

/**
 * Suggestions run on the text captured when the owner asked for them. Typing
 * afterwards only marks them out of date; it never starts another evaluation.
 */
export function draftChanged(
  snapshot: SuggestionDraft,
  live: SuggestionDraft,
): boolean {
  return (
    snapshot.title.trim() !== live.title.trim() ||
    snapshot.description.trim() !== live.description.trim()
  );
}

/** Adds newly confirmed pages; a page confirmed again takes its latest role and project. */
export function addConfirmed(
  current: readonly ConfirmedPage[],
  candidates: readonly PageCandidate[],
  projectRef: string | null,
): ConfirmedPage[] {
  const next = new Map(current.map((page) => [page.pageRef, page]));
  for (const { pageRef, slug, title, role } of candidates)
    next.set(pageRef, { pageRef, slug, title, role, projectRef });
  return [...next.values()];
}

export function removeConfirmed(
  current: readonly ConfirmedPage[],
  pageRefs: readonly string[],
): ConfirmedPage[] {
  const removed = new Set(pageRefs);
  return current.filter((page) => !removed.has(page.pageRef));
}

/** Pages suggested for another project than the one the form now has. */
export function fromOtherProject(
  pages: readonly ConfirmedPage[],
  projectRef: string | null,
): ConfirmedPage[] {
  return pages.filter((page) => page.projectRef !== projectRef);
}

/**
 * Context pages travel with the create/update payload; decision pages go
 * through the owner's explicit link path so they keep their role.
 */
export function confirmedLinks(pages: readonly ConfirmedPage[]) {
  return {
    contextPageRefs: pages
      .filter((page) => page.role === "context")
      .map((page) => page.pageRef),
    decisionPageRefs: pages
      .filter((page) => page.role === "decision")
      .map((page) => page.pageRef),
  };
}

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** What the live region announces once suggestions arrive. */
export function suggestionSummary(
  result: TaskLinkSuggestion & { status?: unknown },
): string {
  const proposal = result.projectProposal;
  if (proposal)
    return proposal.candidates.length
      ? `${plural(proposal.candidates.length, "project", "projects")} proposed. Choose a project to see page suggestions.`
      : "No matching projects. Set a project on the task to see page suggestions.";
  const pages = result.candidates;
  if (!pages.length) return "No matching pages.";
  const decisions = pages.filter((page) => page.role === "decision").length;
  const fallback =
    result.status === "deterministic"
      ? " Ranked without evaluation because it was unavailable."
      : "";
  return `${plural(pages.length, "page", "pages")} suggested${decisions ? `, ${plural(decisions, "decision", "decisions")}` : ""}.${fallback}`;
}
