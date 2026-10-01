import { paginationOffset } from "./pagination";

export { WORKSPACE_PAGE_SIZE as LIBRARY_PAGE_SIZE } from "./pagination";

import {
  type CompanyRelationship,
  isCompanyRelationship,
  PAGE_TYPES,
  type PageType,
  parseSort,
} from "@/lib/brain/types";

export const collectionPaths: Record<PageType, string> = {
  person: "/people",
  company: "/companies",
  project: "/projects",
  article: "/articles",
  decision: "/decisions",
  note: "/notes",
};

export function collectionHref(type: PageType | "") {
  return type ? collectionPaths[type] : "/";
}

export function collectionTypeFromPathname(pathname: string): PageType | "" {
  return PAGE_TYPES.find((type) => collectionPaths[type] === pathname) ?? "";
}

export type LibraryFilters = {
  query: string;
  type: PageType | "";
  /** Narrows the companies collection; ignored for every other collection. */
  relationship: CompanyRelationship | "";
  sort: "updated" | "title";
  offset: number;
};
export type RouteSearchParams = Record<string, string | string[] | undefined>;
export const CONNECTION_PAGE_SIZE = 20;
export const GRAPH_PAGE_SIZE = 150;

export function graphHref(type: PageType | "" = "", offset = 0) {
  const params = new URLSearchParams();
  if (type) params.set("type", type);
  if (offset) params.set("offset", String(offset));
  return params.size ? `/graph?${params}` : "/graph";
}

export function parseLibraryFilters(
  params: { get(name: string): string | null },
  type: PageType | "" = "",
): LibraryFilters {
  const relationship = params.get("relationship");
  return {
    query: (params.get("q") ?? "").trim().slice(0, 500),
    type,
    relationship:
      type === "company" && isCompanyRelationship(relationship)
        ? relationship
        : "",
    sort: parseSort(params.get("sort")),
    offset: paginationOffset(params.get("offset"), 100_000),
  };
}

export function routeSearchParams(values: RouteSearchParams) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string") params.set(key, value);
  }
  return params;
}

export function libraryHref(filters: Partial<LibraryFilters> = {}) {
  const params = new URLSearchParams();
  if (filters.query) params.set("q", filters.query);
  if (filters.type === "company" && filters.relationship)
    params.set("relationship", filters.relationship);
  if (filters.sort === "title") params.set("sort", "title");
  if (filters.offset) params.set("offset", String(filters.offset));
  const pathname = collectionHref(filters.type ?? "");
  return params.size ? `${pathname}?${params}` : pathname;
}

/** New-page form preset with the collection, and a companies relationship filter. */
export function newPageHref(
  filters: Partial<Pick<LibraryFilters, "type" | "relationship">> = {},
) {
  const params = new URLSearchParams();
  if (filters.type) params.set("type", filters.type);
  if (filters.type === "company" && filters.relationship)
    params.set("relationship", filters.relationship);
  return params.size ? `/pages/new?${params}` : "/pages/new";
}

export function pageHref(id: string) {
  return `/pages/${encodeURIComponent(id)}`;
}
