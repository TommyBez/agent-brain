"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useLayoutEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  parseTaskBoardFilters,
  taskBoardHref,
} from "@/lib/workspace/task-urls";

export function BoardFilters() {
  const router = useRouter();
  const params = useSearchParams();
  const filters = parseTaskBoardFilters(params);
  const [draft, setDraft] = useState(filters.query);
  const [pending, startTransition] = useTransition();
  const search = params.toString();
  useLayoutEffect(() => {
    setDraft(parseTaskBoardFilters(new URLSearchParams(search)).query);
  }, [search]);
  return (
    <search className="mb-5">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          startTransition(() =>
            router.push(taskBoardHref({ ...filters, query: draft }), {
              scroll: false,
            }),
          );
        }}
      >
        <div className="relative min-w-56 flex-1 sm:max-w-md">
          <Search
            size={15}
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label="Filter the board"
            placeholder="Filter by text or T-42"
            value={draft}
            maxLength={200}
            onChange={(event) => setDraft(event.target.value)}
            className="pl-9"
          />
        </div>
        <Button type="submit" variant="secondary">
          {pending && <Spinner aria-hidden="true" />}
          Filter
        </Button>
        {(filters.query || filters.projectId) && (
          <Link
            href="/tasks/board"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </Link>
        )}
      </form>
    </search>
  );
}
