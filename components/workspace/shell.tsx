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
      <div className="workspace flex min-h-[100svh]">
        <a
          href="#main-content"
          className="skip-link fixed z-[100] top-[-60px] focus:top-3 left-4 px-4 py-[10px] bg-foreground text-white"
        >
          Skip to content
        </a>
        <aside className="sidebar w-61 bg-[var(--sidebar)] [border-right:1px_solid_var(--line)] p-[28px_20px_0] fixed [inset:0_auto_0_0] flex flex-col z-30 overflow-y-auto max-[1200px]:w-55 max-[1200px]:px-[15px] max-[960px]:w-[194px] max-[960px]:px-3 max-[740px]:hidden">
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
            className="flex flex-1 flex-col px-4 pb-4"
          >
            {sidebar}
          </div>
        </SheetContent>
        <div className="main-shell ml-61 w-[calc(100%_-_244px)] min-w-0 max-[1200px]:ml-55 max-[1200px]:w-[calc(100%_-_220px)] max-[960px]:ml-[194px] max-[960px]:w-[calc(100%_-_194px)] max-[740px]:ml-0 max-[740px]:w-full">
          <header className="topbar h-17 flex items-center justify-between [border-bottom:1px_solid_var(--line)] px-[42px] max-[1200px]:px-[30px] max-[960px]:px-[25px] max-[740px]:justify-start max-[740px]:h-15 max-[740px]:px-[23px] max-[460px]:px-[18px]">
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="mobile-menu hidden max-[740px]:flex max-[740px]:-ml-[5px] max-[740px]:mr-[10px]"
                aria-label="Open navigation"
              >
                <Menu size={20} />
              </Button>
            </SheetTrigger>
            <div className="breadcrumb flex items-center gap-[15px] text-[10px] text-[#8e9485] max-[740px]:gap-2 max-[740px]:text-[9px]">
              Personal brain
              <ChevronRight size={13} />
              <Suspense fallback={<span>Workspace</span>}>
                <WorkspaceBreadcrumb />
              </Suspense>
            </div>
            <span className="private-label flex items-center gap-[7px] text-[#8b947e] text-[8px] tracking-[.13em] max-[960px]:text-[7px] max-[740px]:ml-auto max-[460px]:text-[0px]">
              <span className="status-dot size-[6px] rounded-full bg-[#7c916b] inline-block shrink-0" />
              PRIVATE WORKSPACE
            </span>
          </header>
          <main
            id="main-content"
            className="main-content max-w-[1390px] p-[46px_50px_25px] mx-auto min-[1600px]:pt-15 max-[1200px]:p-[36px_30px_25px] max-[960px]:p-[31px_25px_23px] max-[740px]:p-[30px_23px_23px] max-[460px]:px-[18px]"
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
    <Link
      href="/?focus=search"
      className="sidebar-search flex items-center w-full gap-2 text-[#838a77] text-left text-[11px] px-[9px] mb-7"
    >
      <Search size={15} />
      Find anything<kbd>⌘ K</kbd>
    </Link>
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
