"use client";

import { LogOut, Menu, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Wordmark } from "@/components/wordmark";
import { authClient } from "@/lib/auth-client";
import { PrimaryNavigation } from "./navigation";
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
      <div className="min-h-svh">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
        >
          Skip to content
        </a>
        <SheetContent
          side="right"
          className="overflow-y-auto bg-sidebar"
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
            <SheetTitle>Your workspace</SheetTitle>
            <SheetDescription>
              Collections, agents and settings.
            </SheetDescription>
          </SheetHeader>
          <div
            ref={mobileNavigation}
            className="flex flex-1 flex-col gap-6 px-4 pb-4"
          >
            {sidebar}
          </div>
        </SheetContent>
        <div className="min-w-0">
          <header className="border-b">
            <div className="mx-auto flex max-w-[1360px] flex-wrap items-center gap-x-6 px-5 sm:h-24 md:gap-x-14 md:px-10 lg:px-16">
              <Link
                href="/"
                aria-label="a native brain home"
                className="inline-flex max-sm:py-4"
              >
                <Wordmark />
              </Link>
              <div className="h-11 max-sm:order-3 max-sm:basis-full sm:h-full">
                <Suspense fallback={<div className="w-52" />}>
                  <PrimaryNavigation />
                </Suspense>
              </div>
              <div className="ml-auto flex items-center gap-1 sm:gap-3">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={focusSearch}
                  aria-label="Search pages (Command K)"
                >
                  <Search size={19} />
                </Button>
                <span
                  aria-hidden="true"
                  className="hidden h-5 border-l sm:block"
                />
                <SheetTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Open workspace menu"
                  >
                    <Menu size={20} />
                  </Button>
                </SheetTrigger>
              </div>
            </div>
          </header>
          <main
            id="main-content"
            className="mx-auto max-w-[1360px] px-5 pt-8 pb-20 md:px-10 md:pt-14 lg:px-16"
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
    <Button
      variant="outline"
      asChild
      className="h-10 w-full justify-start border-border/80 bg-background/70 font-normal shadow-none"
    >
      <Link href="/?focus=search">
        <Search />
        Search
        <kbd className="ml-auto rounded border bg-sidebar px-1.5 py-0.5 text-[10px] text-muted-foreground">
          ⌘ K
        </kbd>
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
