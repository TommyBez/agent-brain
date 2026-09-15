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

const navClass = "w-full justify-start";

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
    <Button
      variant={active ? "secondary" : "ghost"}
      className={navClass}
      asChild
    >
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
      <span className="mb-2 block px-3 text-xs font-medium text-muted-foreground">
        WORKSPACE
      </span>
      <NavigationLink href="/">
        <BookOpen size={17} />
        All pages
        <span className="ml-auto text-xs text-muted-foreground">
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
      <span className="mt-6 mb-2 block px-3 text-xs font-medium text-muted-foreground">
        COLLECTIONS
      </span>
      {entityTypes.map((item) => (
        <NavigationLink key={item.id} href={collectionHref(item.id)}>
          <EntityIcon type={item.id} />
          {item.label}
          <span className="ml-auto text-xs text-muted-foreground">
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
