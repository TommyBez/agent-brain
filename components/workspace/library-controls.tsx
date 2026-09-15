"use client";

import { Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { entityTypes } from "@/components/brain-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { useSearchNavigation } from "./search-navigation";

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
          className="library-toolbar flex gap-[10px] items-center mb-[25px] max-[740px]:gap-[9px]"
          onSubmit={(event) => {
            event.preventDefault();
            change({ query: normalizedQuery });
          }}
        >
          <Label className="search-field flex-1 flex flex-row items-center gap-[9px] px-[13px] [border:1px_solid_var(--line)] rounded-[5px] bg-[#fffefb] text-[#8c9580] h-[39px] max-[460px]:pl-[10px] max-[460px]:gap-[7px]">
            <Search size={17} />
            <span className="sr-only">Search pages</span>
            <Input
              id="library-search"
              ref={inputRef}
              name="q"
              value={query}
              onChange={(event) => {
                cancelledForNavigation.current = false;
                setQuery(event.target.value);
              }}
              placeholder="Search your knowledge…"
              autoComplete="off"
              maxLength={500}
            />
            {query && (
              <Button
                type="button"
                variant="ghost"
                className="icon-button bg-transparent size-[30px] rounded-[5px] inline-flex items-center justify-center text-muted-foreground shrink-0"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("");
                  change({ query: "" });
                  inputRef.current?.focus();
                }}
              >
                <X size={15} />
              </Button>
            )}
          </Label>
          <div className="w-32 shrink-0">
            <NativeSelect
              aria-label="Filter by page type"
              name="type"
              className="h-[39px] text-xs text-muted-foreground"
              value={filters.type}
              onChange={(event) =>
                change({ type: event.target.value as LibraryFilters["type"] })
              }
            >
              <NativeSelectOption value="">All types</NativeSelectOption>
              {entityTypes.map((item) => (
                <NativeSelectOption value={item.id} key={item.id}>
                  {item.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="w-36 shrink-0 max-[960px]:hidden">
            <NativeSelect
              aria-label="Sort pages"
              name="sort"
              className="h-[39px] text-xs text-muted-foreground"
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
      <output className="absolute right-0 -bottom-5 text-[10px] text-muted-foreground">
        {pending || normalizedQuery !== filters.query
          ? "Updating results…"
          : ""}
      </output>
    </div>
  );
}
