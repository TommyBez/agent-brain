export const PAGE_TYPES = [
  "person",
  "client",
  "project",
  "article",
  "decision",
  "note",
] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export const LINK_TYPES = [
  "works_at",
  "owns",
  "part_of",
  "relates_to",
  "decided_in",
  "references",
  "depends_on",
  "supersedes",
  "collaborates_with",
] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export interface PageSummary {
  id: string;
  slug: string;
  title: string;
  type: PageType;
  summary: string;
  aliases: string[];
  tags: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  embeddedAt: string | null;
}

export interface BrainLink {
  id: string;
  sourceId: string;
  targetId: string;
  type: LinkType;
  label: string;
}

export interface DecoratedLink extends BrainLink {
  targetTitle: string;
  targetSlug: string;
  sourceTitle: string;
  sourceSlug: string;
}

export interface BrainPage extends PageSummary {
  markdown: string;
  links: BrainLink[];
  backlinks: BrainLink[];
}

export interface DecoratedPage extends BrainPage {
  links: DecoratedLink[];
  backlinks: DecoratedLink[];
}

export interface SearchResult extends PageSummary {
  score: number;
  excerpt: string;
  matchedBy: ("text" | "vector" | "graph")[];
  /** UTF-16 offsets into this page version's canonical Markdown. */
  matchedPassage?: { startOffset: number; endOffset: number; content: string };
}

export interface PageRevision {
  id: string;
  pageId: string;
  version: number;
  snapshot: BrainPage;
  reason: string;
  source: string;
  createdAt: string;
}

export interface Activity {
  id: string;
  pageId: string;
  title: string;
  slug: string;
  action: "create" | "write" | "append" | "embed";
  version: number;
  reason: string;
  source: string;
  createdAt: string;
}

export interface BrainStats {
  pages: number;
  links: number;
  revisions: number;
  embeddedPages: number;
  byType: Partial<Record<PageType, number>>;
  lastUpdated: string | null;
}

export class BrainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: unknown,
  ) {
    super(message);
    this.name = "BrainError";
  }
}

export const MAX_PAGE_CHARACTERS = 200_000;
export function isPageType(value: unknown): value is PageType {
  return PAGE_TYPES.some((type) => type === value);
}
export function isLinkType(value: unknown): value is LinkType {
  return LINK_TYPES.some((type) => type === value);
}
export function parseSort(value: unknown): "updated" | "title" {
  return value === "title" ? "title" : "updated";
}
