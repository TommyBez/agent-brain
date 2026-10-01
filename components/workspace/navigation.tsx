"use client";

import {
  Activity,
  BookOpen,
  Bot,
  Network,
  Plus,
  Settings2,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ComponentProps, type ReactNode, Suspense } from "react";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { entityTypes } from "@/lib/brain/labels";
import type { BrainStats as Stats } from "@/lib/brain/types";
import { collectionHref } from "@/lib/workspace/urls";
import { EntityIcon } from "./primitives";

type NavigationEntry = {
  href: string;
  label: string;
  icon: ReactNode;
  count?: ReactNode;
};

// The mobile sidebar is a Sheet; a completed navigation should reveal the page.
export function SidebarLink(props: ComponentProps<typeof Link>) {
  const { setOpenMobile } = useSidebar();
  return <Link {...props} onNavigate={() => setOpenMobile(false)} />;
}

function NavigationButton({
  entry,
  active,
}: {
  entry: NavigationEntry;
  active: boolean;
}) {
  return (
    <SidebarMenuButton asChild isActive={active} tooltip={entry.label}>
      <SidebarLink href={entry.href} aria-current={active ? "page" : undefined}>
        {entry.icon}
        <span>{entry.label}</span>
      </SidebarLink>
    </SidebarMenuButton>
  );
}

function ActiveNavigationButton({ entry }: { entry: NavigationEntry }) {
  const pathname = usePathname();
  return <NavigationButton entry={entry} active={pathname === entry.href} />;
}

function NavigationItem({ entry }: { entry: NavigationEntry }) {
  return (
    <SidebarMenuItem>
      {/* Pages with request-time params resolve the pathname after prerendering. */}
      <Suspense fallback={<NavigationButton entry={entry} active={false} />}>
        <ActiveNavigationButton entry={entry} />
      </Suspense>
      {entry.count !== undefined && (
        <SidebarMenuBadge>{entry.count}</SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  );
}

function NavigationGroup({
  label,
  entries,
  action,
  className,
}: {
  label: string;
  entries: NavigationEntry[];
  action?: ReactNode;
  className?: string;
}) {
  return (
    <SidebarGroup className={className}>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      {action}
      <SidebarGroupContent>
        <SidebarMenu>
          {entries.map((entry) => (
            <NavigationItem key={entry.href} entry={entry} />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function WorkspaceNavigation({ stats }: { stats?: Stats }) {
  return (
    <>
      <NavigationGroup
        label="Workspace"
        action={
          <SidebarGroupAction asChild title="New page">
            <SidebarLink href="/pages/new">
              <Plus />
              <span className="sr-only">New page</span>
            </SidebarLink>
          </SidebarGroupAction>
        }
        entries={[
          {
            href: "/",
            label: "All pages",
            icon: <BookOpen strokeWidth={1.6} />,
            count: stats?.pages ?? "—",
          },
          {
            href: "/graph",
            label: "Knowledge graph",
            icon: <Network strokeWidth={1.6} />,
          },
          {
            href: "/activity",
            label: "Activity",
            icon: <Activity strokeWidth={1.6} />,
          },
        ]}
      />
      <NavigationGroup
        label="Collections"
        entries={entityTypes.map((item) => ({
          href: collectionHref(item.id),
          label: item.label,
          icon: (
            <EntityIcon
              type={item.id}
              className={`entity-${item.id} text-secondary-foreground`}
            />
          ),
          count: stats ? (stats.byType[item.id] ?? 0) : "—",
        }))}
      />
    </>
  );
}

export function SettingsNavigation() {
  return (
    <NavigationGroup
      label="Settings"
      className="mt-auto"
      entries={[
        {
          href: "/agents",
          label: "Agents & access",
          icon: <Bot strokeWidth={1.6} />,
        },
        {
          href: "/operations",
          label: "Operations",
          icon: <Settings2 strokeWidth={1.6} />,
        },
      ]}
    />
  );
}
