"use client";

import { ChevronsUpDown, LogOut, Search } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Fragment,
  type ReactNode,
  Suspense,
  useLayoutEffect,
  useState,
} from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";
import { entityTypes } from "@/lib/brain/labels";
import { collectionTypeFromPathname } from "@/lib/workspace/urls";
import { useCommandMenu } from "./command-menu";
import { SidebarLink } from "./navigation";

// SidebarProvider persists its state in the `sidebar_state` cookie. Reading it
// in the layout would make the prerendered shell request-time, so the browser
// restores it while hydrating, with transitions off for that first paint.
export function WorkspaceSidebarProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const [restoring, setRestoring] = useState(true);
  useLayoutEffect(() => {
    if (document.cookie.split("; ").includes("sidebar_state=false"))
      setOpen(false);
    const frame = requestAnimationFrame(() => setRestoring(false));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <SidebarProvider
      open={open}
      onOpenChange={setOpen}
      className={restoring ? "[&_*]:transition-none" : undefined}
    >
      {children}
    </SidebarProvider>
  );
}

export function WorkspaceBrand() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" asChild>
          <SidebarLink href="/" aria-label="a native brain home">
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center pb-1.5 font-serif text-[2.25rem] leading-none italic text-brand"
            >
              a
            </span>
            <span className="text-[17px] font-medium tracking-tight">
              native brain
            </span>
          </SidebarLink>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

type Crumb = { label: string; href?: string };

function crumbsFor(pathname: string): Crumb[] {
  const library = { label: "Library", href: "/" };
  const type = collectionTypeFromPathname(pathname);
  if (type)
    return [
      library,
      { label: entityTypes.find((item) => item.id === type)?.label ?? "" },
    ];
  if (pathname === "/pages/new") return [library, { label: "New page" }];
  const page = /^\/pages\/([^/]+)(?:\/(edit|history)(?:\/(\d+))?)?$/.exec(
    pathname,
  );
  if (page) {
    const [, id, view, version] = page;
    const href = `/pages/${id}`;
    if (!view) return [library, { label: "Page" }];
    if (view === "edit")
      return [library, { label: "Page", href }, { label: "Edit" }];
    if (!version)
      return [library, { label: "Page", href }, { label: "History" }];
    return [
      library,
      { label: "Page", href },
      { label: "History", href: `${href}/history` },
      { label: `Version ${version}` },
    ];
  }
  const sections: Record<string, Crumb[]> = {
    "/": [{ label: "Library" }],
    "/graph": [{ label: "Knowledge graph" }],
    "/activity": [{ label: "Activity" }],
    "/agents": [{ label: "Settings" }, { label: "Agents & access" }],
    "/operations": [{ label: "Settings" }, { label: "Operations" }],
  };
  return sections[pathname] ?? [];
}

function WorkspaceBreadcrumb() {
  const crumbs = crumbsFor(usePathname());
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {crumbs.map((crumb, index) => (
          <Fragment key={`${crumb.label}-${crumb.href}`}>
            {index > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem className="min-w-0">
              {crumb.href ? (
                <BreadcrumbLink asChild>
                  <Link href={crumb.href}>{crumb.label}</Link>
                </BreadcrumbLink>
              ) : index === crumbs.length - 1 ? (
                <BreadcrumbPage className="truncate">
                  {crumb.label}
                </BreadcrumbPage>
              ) : (
                <span>{crumb.label}</span>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

export function WorkspaceHeader() {
  const { setOpen } = useCommandMenu();
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur-sm md:px-6">
      <SidebarTrigger aria-label="Toggle sidebar (⌘B)" />
      <Separator
        orientation="vertical"
        className="mr-2 data-[orientation=vertical]:h-4"
      />
      <Suspense>
        <WorkspaceBreadcrumb />
      </Suspense>
      <Button
        variant="outline"
        className="ml-auto h-9 shrink-0 justify-start gap-2 px-3 font-normal text-muted-foreground shadow-none max-md:size-9 max-md:justify-center max-md:border-transparent max-md:px-0 md:w-64"
        aria-label="Search (Command K)"
        onClick={() => setOpen(true)}
      >
        <Search />
        <span className="max-md:sr-only">Search…</span>
        <Kbd className="ml-auto max-md:hidden">⌘K</Kbd>
      </Button>
    </header>
  );
}

export function OwnerMenu({ name, email }: { name: string; email: string }) {
  const { isMobile } = useSidebar();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const displayName = name || "Workspace owner";

  async function signOut() {
    setBusy(true);
    setError(false);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error("Unable to sign out.");
      // A new document drops the router's authenticated cache on sign-out.
      window.location.assign("/sign-in");
    } catch {
      setError(true);
      setBusy(false);
    }
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
            >
              <Avatar>
                <AvatarFallback className="bg-brand-soft text-xs font-semibold text-brand">
                  {(name || email).slice(0, 1).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className="grid min-w-0 flex-1 leading-tight">
                <span className="truncate font-medium">{displayName}</span>
                <span className="truncate text-xs text-muted-foreground">
                  Personal workspace
                </span>
              </span>
              <ChevronsUpDown className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56"
            side={isMobile ? "top" : "right"}
            align="end"
          >
            <DropdownMenuLabel className="grid font-normal">
              <span className="truncate font-medium">{displayName}</span>
              <span className="truncate text-xs text-muted-foreground">
                {email}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={busy} onSelect={signOut}>
              <LogOut />
              {busy ? "Signing out…" : "Sign out"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {error && (
          <p role="alert" className="px-2 pt-1 text-xs text-destructive">
            Unable to sign out. Try again.
          </p>
        )}
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
