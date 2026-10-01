"use client";

import Link from "next/link";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
} from "react";

type SearchEntry = { cancel: () => void; focus: () => void };
type SearchNavigation = {
  register: (entry: SearchEntry) => () => void;
  cancel: () => void;
  focus: () => boolean;
};

const SearchNavigationContext = createContext<SearchNavigation | null>(null);

export function SearchNavigationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const activeSearch = useRef<SearchEntry | null>(null);
  const register = useCallback((entry: SearchEntry) => {
    activeSearch.current = entry;
    return () => {
      if (activeSearch.current === entry) activeSearch.current = null;
    };
  }, []);
  const cancel = useCallback(() => activeSearch.current?.cancel(), []);
  const focus = useCallback(() => {
    if (!activeSearch.current) return false;
    activeSearch.current.focus();
    return true;
  }, []);
  const value = useMemo(
    () => ({ register, cancel, focus }),
    [register, cancel, focus],
  );
  return (
    <SearchNavigationContext value={value}>{children}</SearchNavigationContext>
  );
}

export function useSearchNavigation() {
  const context = useContext(SearchNavigationContext);
  if (!context)
    throw new Error("Search navigation requires the workspace provider.");
  return context;
}

// onNavigate runs synchronously only for actual Next navigations, preserving
// modified clicks/downloads and the framework's normal prefetch behavior.
export function WorkspaceLink({
  onNavigate,
  ...props
}: ComponentProps<typeof Link>) {
  const { cancel } = useSearchNavigation();
  return (
    <Link
      {...props}
      onNavigate={(event) => {
        cancel();
        onNavigate?.(event);
      }}
    />
  );
}
