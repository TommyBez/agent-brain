import { PAGE_TYPES, type PageType } from "@/lib/brain/types";

export type LibraryFilters = {
  query: string;
  type: PageType | "";
  sort: "updated" | "title";
  offset: number;
};
export type RouteSearchParams = Record<string, string | string[] | undefined>;
export const LIBRARY_PAGE_SIZE = 50;

export function parseLibraryFilters(params: {
  get(name: string): string | null;
}): LibraryFilters {
  const type = params.get("type");
  const offset = Number(params.get("offset") ?? 0);
  return {
    query: (params.get("q") ?? "").trim().slice(0, 500),
    type: PAGE_TYPES.includes(type as PageType) ? (type as PageType) : "",
    sort: params.get("sort") === "title" ? "title" : "updated",
    offset:
      Number.isSafeInteger(offset) && offset >= 0
        ? Math.min(offset, 100_000)
        : 0,
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
  if (filters.type) params.set("type", filters.type);
  if (filters.sort === "title") params.set("sort", "title");
  if (filters.offset) params.set("offset", String(filters.offset));
  return params.size ? `/?${params}` : "/";
}

export function pageHref(id: string) {
  return `/pages/${encodeURIComponent(id)}`;
}
