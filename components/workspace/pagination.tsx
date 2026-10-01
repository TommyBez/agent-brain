import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  paginationHref,
  WORKSPACE_PAGE_SIZE,
} from "@/lib/workspace/pagination";
import { WorkspaceLink as Link } from "./search-navigation";

export function Pagination({
  path = "",
  offset,
  hasMore,
  pageSize = WORKSPACE_PAGE_SIZE,
  href,
  previousLabel = "Newer entries",
  nextLabel = "Older entries",
  label = "Pagination",
  children,
}: {
  path?: string;
  offset: number;
  hasMore: boolean;
  pageSize?: number;
  href?: (offset: number) => string;
  previousLabel?: string;
  nextLabel?: string;
  label?: string;
  children?: ReactNode;
}) {
  if (!offset && !hasMore) return null;
  const url = href ?? ((offset: number) => paginationHref(path, offset));
  return (
    <nav
      aria-label={label}
      className="mt-6 flex items-center justify-between gap-3"
    >
      {children}
      {offset > 0 ? (
        <Button variant="outline" asChild>
          <Link href={url(Math.max(0, offset - pageSize))}>
            {previousLabel}
          </Link>
        </Button>
      ) : (
        <span />
      )}
      {hasMore && (
        <Button variant="outline" asChild>
          <Link href={url(offset + pageSize)}>{nextLabel}</Link>
        </Button>
      )}
    </nav>
  );
}
