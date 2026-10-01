"use client";

import { Search, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { entityTypes } from "@/lib/brain/labels";
import type { BrainStats as Stats } from "@/lib/brain/types";
import { type PageType, parseSort } from "@/lib/brain/types";
import {
  type LibraryFilters,
  libraryHref,
  parseLibraryFilters,
} from "@/lib/workspace/urls";

export function LibraryCollections({
  stats,
  type,
}: {
  stats?: Stats;
  type: PageType | "";
}) {
  const params = useSearchParams();
  const filters = parseLibraryFilters(params, type);
  return (
    <nav
      aria-label="Collections"
      aria-busy={!stats}
      className="mb-5 flex gap-6 overflow-x-auto border-b whitespace-nowrap sm:mb-7 sm:gap-8"
    >
      {[{ id: "" as const, label: "All pages" }, ...entityTypes].map((item) => {
        const active = filters.type === item.id;
        const count = item.id
          ? (stats?.byType[item.id] ?? (stats ? 0 : "—"))
          : (stats?.pages ?? "—");
        return (
          <Link
            key={item.id}
            href={libraryHref({ ...filters, type: item.id, offset: 0 })}
            aria-current={active ? "page" : undefined}
            className={`flex items-baseline gap-2 border-b-2 pt-2 pb-4 text-[13px] transition-colors ${active ? "border-brand font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {item.label}
            <span className="text-[10px] font-normal tabular-nums text-muted-foreground">
              {count}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

// Filters this list on submit. Search-as-you-type across the whole workspace
// lives in the command menu (⌘K).
export function LibraryControls({ type }: { type: PageType | "" }) {
  const router = useRouter();
  const filters = parseLibraryFilters(useSearchParams(), type);
  const [pending, startTransition] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(filters.query);
  // Back/Forward and collection links replace an unsubmitted draft.
  const [shownQuery, setShownQuery] = useState(filters.query);
  if (shownQuery !== filters.query) {
    setShownQuery(filters.query);
    setDraft(filters.query);
  }

  function navigate(changes: Partial<LibraryFilters>) {
    const href = libraryHref({
      ...filters,
      query: draft.trim().slice(0, 500),
      offset: 0,
      ...changes,
    });
    startTransition(() => router.push(href, { scroll: false }));
  }

  return (
    <div className="relative" data-pending={pending}>
      <search>
        <form
          className="mb-6 flex items-center justify-between gap-3 sm:mb-8"
          onSubmit={(event) => {
            event.preventDefault();
            navigate({});
          }}
        >
          <Label htmlFor="library-search" className="sr-only">
            Filter pages
          </Label>
          <InputGroup className="h-11 min-w-0 flex-1 basis-0 rounded-none border-0 border-b border-transparent bg-transparent shadow-none focus-within:border-input focus-within:ring-0 sm:max-w-md">
            <InputGroupInput
              ref={input}
              id="library-search"
              name="q"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Filter pages…"
              autoComplete="off"
              maxLength={500}
            />
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            {draft && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  aria-label="Clear filter"
                  onClick={() => {
                    setDraft("");
                    input.current?.focus();
                    if (filters.query) navigate({ query: "" });
                  }}
                >
                  <X aria-hidden="true" />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
          <div className="w-32 shrink-0 sm:w-36">
            <NativeSelect
              className="h-10 border-0 bg-transparent shadow-none text-xs"
              aria-label="Sort pages"
              value={filters.sort}
              onChange={(event) =>
                navigate({ sort: parseSort(event.target.value) })
              }
            >
              <NativeSelectOption value="updated">
                Last updated
              </NativeSelectOption>
              <NativeSelectOption value="title">Title A–Z</NativeSelectOption>
            </NativeSelect>
          </div>
        </form>
      </search>
      <output className="absolute right-0 -bottom-5 text-xs text-muted-foreground">
        {pending ? "Updating results…" : ""}
      </output>
    </div>
  );
}
