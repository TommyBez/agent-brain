import type { PageType } from "@/lib/brain/types";

const collectionPaths: Record<PageType, string> = {
  person: "/people",
  client: "/clients",
  project: "/projects",
  article: "/articles",
  decision: "/decisions",
  note: "/notes",
};

export function collectionHref(type: PageType | "") {
  return type ? collectionPaths[type] : "/";
}

export function collectionTypeFromPathname(pathname: string): PageType | "" {
  return (
    (Object.keys(collectionPaths) as PageType[]).find(
      (type) => collectionPaths[type] === pathname,
    ) ?? ""
  );
}

export type LibraryFilters = {
  query: string;
  type: PageType | "";
  sort: "updated" | "title";
  offset: number;
};
export type RouteSearchParams = Record<string, string | string[] | undefined>;
export const LIBRARY_PAGE_SIZE = 50;

export function parseLibraryFilters(
  params: { get(name: string): string | null },
  type: PageType | "" = "",
): LibraryFilters {
  const offset = Number(params.get("offset") ?? 0);
  return {
    query: (params.get("q") ?? "").trim().slice(0, 500),
    type,
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
  if (filters.sort === "title") params.set("sort", "title");
  if (filters.offset) params.set("offset", String(filters.offset));
  const pathname = collectionHref(filters.type ?? "");
  return params.size ? `${pathname}?${params}` : pathname;
}

export function pageHref(id: string) {
  return `/pages/${encodeURIComponent(id)}`;
}
