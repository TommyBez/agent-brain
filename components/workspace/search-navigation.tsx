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

type SearchNavigation = {
  register: (cancel: () => void) => () => void;
  cancel: () => void;
};

const SearchNavigationContext = createContext<SearchNavigation | null>(null);

export function SearchNavigationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const activeSearch = useRef<(() => void) | null>(null);
  const register = useCallback((cancel: () => void) => {
    activeSearch.current = cancel;
    return () => {
      if (activeSearch.current === cancel) activeSearch.current = null;
    };
  }, []);
  const cancel = useCallback(() => activeSearch.current?.(), []);
  const value = useMemo(() => ({ register, cancel }), [register, cancel]);
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
