"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { PageType } from "@/lib/brain/types";
import {
  type LibraryFilters,
  libraryHref,
  parseLibraryFilters,
} from "@/lib/workspace/urls";
import { useSearchNavigation } from "./search-navigation";

// TODO: Replace the navigation flags with an idle/debouncing/navigating/cancelled reducer.
export function useUrlSyncedSearch(
  type: PageType | "",
  inputRef: React.RefObject<HTMLInputElement | null>,
) {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const { register } = useSearchNavigation();
  const filters = parseLibraryFilters(params, type);
  const [query, setQuery] = useState(filters.query);
  const [pending, startTransition] = useTransition();
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

  const focusInput = useCallback(() => {
    const input = inputRef.current;
    input?.focus();
  }, [inputRef]);

  useEffect(() => {
    function cancelSearch() {
      cancelledForNavigation.current = true;
      clearTimeout(debounceTimer.current);
      pendingNavigation.current = null;
      setQuery(
        parseLibraryFilters(new URLSearchParams(serialized), type).query,
      );
    }
    const unregister = register({
      cancel: cancelSearch,
      focus: focusInput,
    });
    window.addEventListener("popstate", cancelSearch);
    return () => {
      clearTimeout(debounceTimer.current);
      unregister();
      window.removeEventListener("popstate", cancelSearch);
    };
  }, [register, serialized, type, focusInput]);

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
    if (focusSearch) focusInput();
  }, [focusSearch, focusInput]);

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

  return {
    filters,
    query,
    pending,
    normalizedQuery,
    change,
    setQuery: (value: string) => {
      cancelledForNavigation.current = false;
      setQuery(value);
    },
  };
}
