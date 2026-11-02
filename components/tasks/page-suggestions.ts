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

type ProjectPhase = Extract<TaskLinkSuggestion, { kind: "project" }>;
type PagesPhase = Extract<TaskLinkSuggestion, { kind: "pages" }>;

/** Compile-time exhaustiveness for `switch (result.kind)`. */
export function unreachableKind(result: never): never {
  throw new Error(
    `Unknown suggestion kind: ${JSON.stringify((result as { kind?: unknown })?.kind)}`,
  );
}

/** The 8 s budget fired before project reads or evaluation finished. */
export function projectTimedOut(result: ProjectPhase): boolean {
  return (
    result.fallbackReason === "deadline" ||
    result.projectProposal.fallbackReason === "deadline"
  );
}

/** Message for the project chooser when it has no candidates to show. */
export function emptyProjectMessage(result: ProjectPhase): string {
  return projectTimedOut(result)
    ? "Project evaluation timed out before it finished. Suggest again, or set a project on the task to see page suggestions."
    : "No matching projects. Set a project on the task to see page suggestions.";
}

/** Shared wording for lists ranked without JEV, for both phases. */
const UNEVALUATED = " Ranked without evaluation because it was unavailable.";

function projectSummary(result: ProjectPhase): string {
  const { candidates, status } = result.projectProposal;
  if (!candidates.length) return emptyProjectMessage(result);
  return `${plural(candidates.length, "project", "projects")} proposed.${status === "deterministic" ? UNEVALUATED : ""} Choose a project to see page suggestions.`;
}

/** A timeout does not establish that nothing matches. */
export function emptyPagesMessage(result: PagesPhase): string {
  return result.fallbackReason === "deadline"
    ? "Page evaluation timed out before it finished. Suggest again."
    : "No matching pages.";
}

function pagesSummary(result: PagesPhase): string {
  const pages = result.candidates;
  if (!pages.length) return emptyPagesMessage(result);
  const decisions = pages.filter((page) => page.role === "decision").length;
  return `${plural(pages.length, "page", "pages")} suggested${decisions ? `, ${plural(decisions, "decision", "decisions")}` : ""}.${result.status === "deterministic" ? UNEVALUATED : ""}`;
}

/** What the live region announces once suggestions arrive. */
export function suggestionSummary(result: TaskLinkSuggestion): string {
  switch (result.kind) {
    case "project":
      return projectSummary(result);
    case "pages":
      return pagesSummary(result);
    default:
      return unreachableKind(result);
  }
}

/**
 * Muted note for candidates JEV did not judge. Evaluated results list only
 * judged pages; a deterministic list already says it was not evaluated.
 */
export function unevaluatedPagesNote(result: PagesPhase): string | null {
  const count = result.unevaluatedPageRefs?.length ?? 0;
  if (!count || result.status === "deterministic") return null;
  return `${plural(count, "other page", "other pages")} could not be evaluated and ${count === 1 ? "is" : "are"} not listed.`;
}
