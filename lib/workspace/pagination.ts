export const WORKSPACE_PAGE_SIZE = 50;

export type PaginationSearchParams = Promise<{
  offset?: string | string[];
}>;

export function paginationOffset(
  value: string | string[] | undefined | null,
  maximum = Infinity,
) {
  const offset = typeof value === "string" ? Number(value) : 0;
  return Number.isSafeInteger(offset) && offset >= 0
    ? Math.min(offset, maximum)
    : 0;
}

export function paginationHref(path: string, offset: number) {
  return offset > 0 ? `${path}?offset=${offset}` : path;
}
