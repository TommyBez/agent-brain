"use client";

import { Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { entityTypes, type Stats } from "@/components/brain-types";
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
import type { PageType } from "@/lib/brain/types";
import {
  type LibraryFilters,
  libraryHref,
  parseLibraryFilters,
} from "@/lib/workspace/urls";
import {
  WorkspaceLink as Link,
  useSearchNavigation,
} from "./search-navigation";

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

export function LibraryControls({ type }: { type: PageType | "" }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const { register } = useSearchNavigation();
  const filters = parseLibraryFilters(params, type);
  const [query, setQuery] = useState(filters.query);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const serialized = params.toString();
  const location = serialized ? `${pathname}?${serialized}` : pathname;
  const observedLocation = useRef(location);
  const pendingNavigation = useRef<{
    href: string;
    filters: LibraryFilters;
  } | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const resetDraft = useRef(false);
  const cancelledForNavigation = useRef(false);
  const normalizedQuery = query.trim().slice(0, 500);

  useEffect(() => {
    function cancelSearch() {
      cancelledForNavigation.current = true;
      clearTimeout(debounceTimer.current);
      pendingNavigation.current = null;
      setQuery(
        parseLibraryFilters(new URLSearchParams(serialized), type).query,
      );
    }
    const unregister = register(cancelSearch);
    window.addEventListener("popstate", cancelSearch);
    return () => {
      clearTimeout(debounceTimer.current);
      unregister();
      window.removeEventListener("popstate", cancelSearch);
    };
  }, [register, serialized, type]);

  useEffect(() => {
    if (observedLocation.current === location) return;
    observedLocation.current = location;
    cancelledForNavigation.current = false;
    const ownNavigation = pendingNavigation.current?.href === location;
    pendingNavigation.current = null;
    if (!ownNavigation) {
      // A collection link or browser Back/Forward replaces an unsubmitted draft,
      // even when both URLs have the same (usually empty) query.
      clearTimeout(debounceTimer.current);
      resetDraft.current = true;
      setQuery(
        parseLibraryFilters(new URLSearchParams(serialized), type).query,
      );
    }
  }, [location, serialized, type]);

  useEffect(() => {
    // Also prevent an already queued passive effect from rearming after a click.
    if (cancelledForNavigation.current) return;
    if (resetDraft.current) {
      resetDraft.current = false;
      return;
    }
    const current = parseLibraryFilters(new URLSearchParams(serialized), type);
    if (normalizedQuery === current.query) return;
    debounceTimer.current = setTimeout(() => {
      if (
        cancelledForNavigation.current ||
        observedLocation.current !== location
      )
        return;
      // Keep a type/sort change that is still navigating when more text arrives.
      const next = {
        ...(pendingNavigation.current?.filters ?? current),
        query: normalizedQuery,
        offset: 0,
      };
      const href = libraryHref(next);
      pendingNavigation.current = { href, filters: next };
      startTransition(() => router.replace(href, { scroll: false }));
    }, 220);
    return () => clearTimeout(debounceTimer.current);
  }, [normalizedQuery, location, serialized, type, router]);

  const focusSearch = params.get("focus") === "search";
  useEffect(() => {
    if (focusSearch) inputRef.current?.focus();
  }, [focusSearch]);

  function change(values: Partial<LibraryFilters>) {
    cancelledForNavigation.current = false;
    clearTimeout(debounceTimer.current);
    const next = {
      ...(pendingNavigation.current?.filters ?? filters),
      query: normalizedQuery,
      offset: 0,
      ...values,
    };
    const href = libraryHref(next);
    pendingNavigation.current = { href, filters: next };
    startTransition(() => router.push(href, { scroll: false }));
  }

  return (
    <div
      className="relative"
      data-pending={pending || normalizedQuery !== filters.query}
    >
      <search>
        <form
          className="mb-6 flex items-center justify-between gap-3 sm:mb-8"
          onSubmit={(event) => {
            event.preventDefault();
            change({ query: normalizedQuery });
          }}
        >
          <Label htmlFor="library-search" className="sr-only">
            Search pages
          </Label>
          <InputGroup className="h-11 min-w-0 flex-1 basis-0 rounded-none border-0 border-b border-transparent bg-transparent shadow-none focus-within:border-input focus-within:ring-0 sm:max-w-md">
            <InputGroupInput
              id="library-search"
              ref={inputRef}
              name="q"
              value={query}
              onChange={(event) => {
                cancelledForNavigation.current = false;
                setQuery(event.target.value);
              }}
              placeholder="Search pages…"
              autoComplete="off"
              maxLength={500}
            />
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            {query && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  aria-label="Clear search"
                  onClick={() => {
                    setQuery("");
                    change({ query: "" });
                    inputRef.current?.focus();
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
              name="sort"
              value={filters.sort}
              onChange={(event) =>
                change({ sort: event.target.value as LibraryFilters["sort"] })
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
        {pending || normalizedQuery !== filters.query
          ? "Updating results…"
          : ""}
      </output>
    </div>
  );
}
