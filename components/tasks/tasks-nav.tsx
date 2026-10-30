"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import { cn } from "@/lib/utils";

const VIEWS = [
  { href: "/tasks", label: "Overview", match: "overview" },
  { href: "/tasks?view=needs-you", label: "Needs you", match: "needs-you" },
  { href: "/tasks/board", label: "Board", match: "board" },
  { href: "/tasks/calendar", label: "Calendar", match: "calendar" },
  { href: "/tasks/agenda", label: "Agenda", match: "agenda" },
] as const;

function current(pathname: string, view: string | null) {
  if (pathname === "/tasks")
    return view === "needs-you" ? "needs-you" : "overview";
  return pathname.split("/")[2] ?? "";
}

function Links({ active }: { active: string }) {
  return (
    <>
      {VIEWS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={active === item.match ? "page" : undefined}
          className={cn(
            "border-b-2 pt-2 pb-3 text-[13px] whitespace-nowrap transition-colors",
            active === item.match
              ? "border-brand font-medium text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {item.label}
        </Link>
      ))}
    </>
  );
}

function ActiveLinks() {
  const pathname = usePathname();
  const view = useSearchParams().get("view");
  return <Links active={current(pathname, view)} />;
}

/** The task views, and live refresh for whichever one is open. */
export function TasksNav() {
  useLiveRefresh();
  return (
    <nav
      aria-label="Task views"
      className="mb-8 flex gap-6 overflow-x-auto border-b sm:gap-8"
    >
      <Suspense fallback={<Links active="" />}>
        <ActiveLinks />
      </Suspense>
    </nav>
  );
}
