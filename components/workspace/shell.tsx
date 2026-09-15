"use client";

import { ChevronRight, LogOut, Menu, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, Suspense, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
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
  const router = useRouter();
  const { cancel } = useSearchNavigation();
  useEffect(() => {
    function find(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setOpen(false);
        const input = document.getElementById("library-search");
        // Activity preserves library DOM while its route is hidden.
        if (input && input.getClientRects().length > 0) input.focus();
        else {
          cancel();
          router.push("/?focus=search");
        }
      }
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", find);
    return () => window.removeEventListener("keydown", find);
  }, [router, cancel]);

  return (
    <div className="workspace flex min-h-[100svh]">
      <a
        href="#main-content"
        className="skip-link fixed z-[100] top-[-60px] left-4 px-4 py-[10px] bg-foreground text-white"
      >
        Skip to content
      </a>
      {open && (
        <Button
          variant="ghost"
          className="sidebar-scrim h-auto w-auto max-[740px]:fixed max-[740px]:inset-0 max-[740px]:bg-[#25371945] max-[740px]:z-[25]"
          onClick={() => setOpen(false)}
          aria-label="Close navigation"
        />
      )}
      <aside
        className={`sidebar w-61 bg-[var(--sidebar)] [border-right:1px_solid_var(--line)] p-[28px_20px_0] fixed [inset:0_auto_0_0] flex flex-col z-30 overflow-y-auto max-[1200px]:w-55 max-[1200px]:px-[15px] max-[960px]:w-[194px] max-[960px]:px-3 max-[740px]:w-61 max-[740px]:-translate-x-full max-[740px]:transition-transform max-[740px]:shadow-xl ${open ? "is-open" : ""}`}
        onClickCapture={(event) => {
          if ((event.target as HTMLElement).closest("a")) setOpen(false);
        }}
      >
        {sidebar}
      </aside>
      <div className="main-shell ml-61 w-[calc(100%_-_244px)] min-w-0 max-[1200px]:ml-55 max-[1200px]:w-[calc(100%_-_220px)] max-[960px]:ml-[194px] max-[960px]:w-[calc(100%_-_194px)] max-[740px]:ml-0 max-[740px]:w-full">
        <header className="topbar h-17 flex items-center justify-between [border-bottom:1px_solid_var(--line)] px-[42px] max-[1200px]:px-[30px] max-[960px]:px-[25px] max-[740px]:justify-start max-[740px]:h-15 max-[740px]:px-[23px] max-[460px]:px-[18px]">
          <Button
            variant="ghost"
            className="icon-button bg-transparent w-[30px] h-[30px] rounded-[5px] items-center justify-center text-muted-foreground shrink-0 mobile-menu hidden max-[740px]:flex max-[740px]:-ml-[5px] max-[740px]:mr-[10px]"
            aria-label="Open navigation"
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            <Menu size={20} />
          </Button>
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
        className="icon-button bg-transparent size-[30px] rounded-[5px] inline-flex items-center justify-center text-muted-foreground shrink-0"
        aria-label="Sign out"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const result = await authClient.signOut();
          if (result.error) {
            setError(true);
            setBusy(false);
            return;
          }
          // A new document drops the router's authenticated cache on sign-out.
          window.location.assign("/sign-in");
        }}
      >
        <LogOut size={16} />
      </Button>
      {error && <span role="alert">Unable to sign out.</span>}
    </>
  );
}
