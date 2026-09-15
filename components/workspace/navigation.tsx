"use client";

import { Activity, BookOpen, Bot, Network, Settings2 } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { type ReactNode, Suspense } from "react";
import { entityTypes, type Stats } from "@/components/brain-types";
import { EntityIcon } from "./primitives";
import { WorkspaceLink as Link } from "./search-navigation";

const navClass =
  "nav-item flex items-center w-full gap-[10px] bg-transparent p-[10px_11px] rounded-[5px] text-[#717968] text-[11px] text-left my-[2px] min-h-9 transition-colors";

function ActiveNavigationLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const target = new URL(href, "https://brain.invalid");
  const active =
    pathname === target.pathname &&
    (pathname !== "/" ||
      (params.get("type") ?? "") === (target.searchParams.get("type") ?? ""));
  return (
    <Link
      href={href}
      className={`${navClass} ${active ? "active" : ""}`}
      aria-current={active ? "page" : undefined}
    >
      {children}
    </Link>
  );
}

function NavigationLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Suspense
      fallback={
        <Link href={href} className={navClass}>
          {children}
        </Link>
      }
    >
      <ActiveNavigationLink href={href}>{children}</ActiveNavigationLink>
    </Suspense>
  );
}

export function WorkspaceNavigation({ stats }: { stats?: Stats }) {
  return (
    <nav aria-label="Workspace navigation">
      <span className="nav-label block text-[#979e8c] text-[8px] font-semibold tracking-[.16em] px-[10px] mb-[10px]">
        WORKSPACE
      </span>
      <NavigationLink href="/">
        <BookOpen size={17} />
        All pages<span>{stats?.pages ?? "—"}</span>
      </NavigationLink>
      <NavigationLink href="/graph">
        <Network size={17} />
        Knowledge graph
      </NavigationLink>
      <NavigationLink href="/activity">
        <Activity size={17} />
        Activity
      </NavigationLink>
      <span className="nav-label block text-[#979e8c] text-[8px] font-semibold tracking-[.16em] px-[10px] mb-[10px] mt-[27px]">
        COLLECTIONS
      </span>
      {entityTypes.map((item) => (
        <NavigationLink key={item.id} href={`/?type=${item.id}`}>
          <EntityIcon type={item.id} />
          {item.label}
          <span>{stats ? (stats.byType[item.id] ?? 0) : "—"}</span>
        </NavigationLink>
      ))}
    </nav>
  );
}

export function SettingsNavigation() {
  return (
    <>
      <NavigationLink href="/agents">
        <Bot size={17} />
        Agents & access
      </NavigationLink>
      <NavigationLink href="/operations">
        <Settings2 size={17} />
        Operations
      </NavigationLink>
    </>
  );
}

export function WorkspaceBreadcrumb() {
  const pathname = usePathname();
  const params = useSearchParams();
  const title =
    pathname === "/"
      ? (entityTypes.find((t) => t.id === params.get("type"))?.label ??
        "All pages")
      : pathname === "/graph"
        ? "Knowledge graph"
        : pathname === "/activity"
          ? "Activity"
          : pathname === "/agents"
            ? "Agents & access"
            : pathname === "/operations"
              ? "Operations"
              : pathname === "/pages/new"
                ? "New page"
                : pathname.endsWith("/edit")
                  ? "Edit page"
                  : "Page";
  return <span>{title}</span>;
}
