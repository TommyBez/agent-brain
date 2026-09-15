"use client";

import { ChevronRight, LogOut, Menu, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { authClient } from "@/lib/auth-client";
import { WorkspaceBreadcrumb } from "./navigation";
import {
  WorkspaceLink as Link,
  useSearchNavigation,
} from "./search-navigation";

export function WorkspaceShell({
  sidebar,
  children,
}: {
  sidebar: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const closeFocus = useRef<"search" | "navigation" | null>(null);
  const mobileNavigation = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { cancel } = useSearchNavigation();
  const focusSearch = useCallback(() => {
    // Activity retains previous collection inputs in hidden route trees.
    const input = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[id="library-search"]'),
    ).find((candidate) => candidate.getClientRects().length > 0);
    if (input) input.focus();
    else {
      cancel();
      router.push("/?focus=search");
    }
  }, [router, cancel]);
  useEffect(() => {
    function find(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        if (open) {
          closeFocus.current = "search";
          setOpen(false);
        } else {
          focusSearch();
        }
      }
    }
    window.addEventListener("keydown", find);
    return () => window.removeEventListener("keydown", find);
  }, [focusSearch, open]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <div className="flex min-h-svh">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
        >
          Skip to content
        </a>
        <aside className="fixed inset-y-0 left-0 z-30 flex w-64 flex-col gap-6 overflow-y-auto border-r bg-sidebar p-6 max-[740px]:hidden">
          {sidebar}
        </aside>
        <SheetContent
          side="left"
          className="overflow-y-auto"
          onOpenAutoFocus={(event) => {
            // This Sheet contains navigation links before its action buttons.
            const firstLink = mobileNavigation.current?.querySelector("a");
            if (firstLink) {
              event.preventDefault();
              firstLink.focus();
            }
          }}
          onClickCapture={(event) => {
            const link = (event.target as HTMLElement).closest("a");
            if (
              !link ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            closeFocus.current =
              new URL(link.href).searchParams.get("focus") === "search"
                ? "search"
                : "navigation";
            setOpen(false);
          }}
          onCloseAutoFocus={(event) => {
            const target = closeFocus.current;
            closeFocus.current = null;
            if (target === "search") {
              event.preventDefault();
              focusSearch();
            }
          }}
        >
          <SheetHeader>
            <SheetTitle>Navigation</SheetTitle>
            <SheetDescription>Browse and organize your brain.</SheetDescription>
          </SheetHeader>
          <div
            ref={mobileNavigation}
            className="flex flex-1 flex-col gap-6 px-4 pb-4"
          >
            {sidebar}
          </div>
        </SheetContent>
        <div className="ml-64 min-w-0 flex-1 max-[740px]:ml-0">
          <header className="flex h-16 items-center gap-4 border-b px-4 md:px-6">
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="hidden max-[740px]:inline-flex"
                aria-label="Open navigation"
              >
                <Menu size={20} />
              </Button>
            </SheetTrigger>
            <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
              <span className="hidden sm:inline">Personal brain</span>
              <ChevronRight className="hidden size-4 shrink-0 sm:block" />
              <Suspense fallback={<span>Workspace</span>}>
                <WorkspaceBreadcrumb />
              </Suspense>
            </div>
            <Badge variant="outline" className="ml-auto">
              Private
            </Badge>
          </header>
          <main
            id="main-content"
            className="mx-auto max-w-7xl p-4 md:p-6 lg:p-8"
          >
            {children}
          </main>
        </div>
      </div>
    </Sheet>
  );
}

export function FindKnowledge() {
  return (
    <Button variant="outline" asChild className="w-full justify-start">
      <Link href="/?focus=search">
        <Search />
        Find anything
        <kbd className="ml-auto text-xs text-muted-foreground">⌘ K</kbd>
      </Link>
    </Button>
  );
}

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Sign out"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(false);
          try {
            const result = await authClient.signOut();
            if (result.error) throw new Error("Unable to sign out.");
            // A new document drops the router's authenticated cache on sign-out.
            window.location.assign("/sign-in");
          } catch {
            setError(true);
          } finally {
            setBusy(false);
          }
        }}
      >
        <LogOut size={16} />
      </Button>
      {error && <span role="alert">Unable to sign out.</span>}
    </>
  );
}
