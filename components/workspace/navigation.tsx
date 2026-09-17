"use client";

import { Activity, BookOpen, Bot, Network, Settings2 } from "lucide-react";
import { usePathname } from "next/navigation";
import { type ReactNode, Suspense } from "react";
import { entityTypes, type Stats } from "@/components/brain-types";
import { Button } from "@/components/ui/button";
import {
  collectionHref,
  collectionTypeFromPathname,
} from "@/lib/workspace/urls";
import { EntityIcon } from "./primitives";
import { WorkspaceLink as Link } from "./search-navigation";

const navClass = "h-10 w-full justify-start gap-3 rounded-lg px-3 font-normal";

export function PrimaryNavigation() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Main navigation"
      className="flex h-full items-stretch gap-7 sm:gap-8"
    >
      {[
        { href: "/", label: "Library" },
        { href: "/graph", label: "Graph" },
        { href: "/activity", label: "Activity" },
      ].map(({ href, label }) => {
        const active =
          href === "/"
            ? pathname === "/" ||
              !!collectionTypeFromPathname(pathname) ||
              pathname.startsWith("/pages/")
            : pathname === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`inline-flex items-center border-b-2 px-0.5 text-[13px] font-medium transition-colors ${active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

function ActiveNavigationLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const active = pathname === href;
  return (
    <Button variant={active ? "default" : "ghost"} className={navClass} asChild>
      <Link href={href} aria-current={active ? "page" : undefined}>
        {children}
      </Link>
    </Button>
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
        <Button variant="ghost" className={navClass} asChild>
          <Link href={href}>{children}</Link>
        </Button>
      }
    >
      <ActiveNavigationLink href={href}>{children}</ActiveNavigationLink>
    </Suspense>
  );
}

export function WorkspaceNavigation({ stats }: { stats?: Stats }) {
  return (
    <nav aria-label="Workspace navigation" className="space-y-1">
      <span className="mb-3 block px-3 text-[11px] font-medium text-muted-foreground">
        Workspace
      </span>
      <NavigationLink href="/">
        <BookOpen size={17} />
        All pages
        <span className="ml-auto text-xs tabular-nums">
          {stats?.pages ?? "—"}
        </span>
      </NavigationLink>
      <NavigationLink href="/graph">
        <Network size={17} />
        Knowledge graph
      </NavigationLink>
      <NavigationLink href="/activity">
        <Activity size={17} />
        Activity
      </NavigationLink>
      <span className="mt-7 mb-3 block px-3 text-[11px] font-medium text-muted-foreground">
        Collections
      </span>
      {entityTypes.map((item) => (
        <NavigationLink key={item.id} href={collectionHref(item.id)}>
          <span
            className={`entity-${item.id} text-secondary-foreground in-[[aria-current=page]]:text-primary-foreground`}
          >
            <EntityIcon type={item.id} />
          </span>
          {item.label}
          <span className="ml-auto text-xs tabular-nums">
            {stats ? (stats.byType[item.id] ?? 0) : "—"}
          </span>
        </NavigationLink>
      ))}
    </nav>
  );
}

export function SettingsNavigation() {
  return (
    <nav aria-label="Workspace settings" className="space-y-1">
      <NavigationLink href="/agents">
        <Bot size={17} />
        Agents & access
      </NavigationLink>
      <NavigationLink href="/operations">
        <Settings2 size={17} />
        Operations
      </NavigationLink>
    </nav>
  );
}

export function WorkspaceBreadcrumb() {
  const pathname = usePathname();
  const collection = collectionTypeFromPathname(pathname);
  const title = collection
    ? entityTypes.find((item) => item.id === collection)?.label
    : pathname === "/"
      ? "All pages"
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
                  : pathname.endsWith("/history")
                    ? "Page history"
                    : /\/history\/[^/]+$/.test(pathname)
                      ? "Page revision"
                      : "Page";
  return <span className="truncate text-foreground">{title}</span>;
}
