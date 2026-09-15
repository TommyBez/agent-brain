import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  paginationHref,
  WORKSPACE_PAGE_SIZE,
} from "@/lib/workspace/pagination";

export function Pagination({
  path,
  offset,
  hasMore,
}: {
  path: string;
  offset: number;
  hasMore: boolean;
}) {
  if (!offset && !hasMore) return null;
  return (
    <nav aria-label="Pagination" className="mt-6 flex justify-between gap-3">
      {offset > 0 ? (
        <Button variant="outline" asChild>
          <Link
            href={paginationHref(
              path,
              Math.max(0, offset - WORKSPACE_PAGE_SIZE),
            )}
          >
            Newer entries
          </Link>
        </Button>
      ) : (
        <span />
      )}
      {hasMore && (
        <Button variant="outline" asChild>
          <Link href={paginationHref(path, offset + WORKSPACE_PAGE_SIZE)}>
            Older entries
          </Link>
        </Button>
      )}
    </nav>
  );
}
