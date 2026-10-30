"use client";

import {
  Activity,
  BookOpen,
  Bot,
  ListTodo,
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
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  BADGE_REFRESH_MS,
  type SavedViewLink,
  useTaskSignals,
} from "@/hooks/use-live-refresh";
import { entityTypes } from "@/lib/brain/labels";
import type { BrainStats as Stats } from "@/lib/brain/types";
import { collectionHref } from "@/lib/workspace/urls";
import { EntityIcon } from "./primitives";

/** What the server knows about tasks for the sidebar; absent when disabled. */
export type TaskNavigation = {
  needsYou: number | null;
  views: SavedViewLink[];
};

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

function ActiveTasksButton({ entry }: { entry: NavigationEntry }) {
  const pathname = usePathname();
  return (
    <NavigationButton
      entry={entry}
      active={pathname === "/tasks" || pathname.startsWith("/tasks/")}
    />
  );
}

// Rendered by the server whenever tasks are enabled. The badge counts what
// waits for the owner and saved views follow as links: the server's values
// until the shared poll answers, which then keeps them current.
function TasksNavigationItem({ initial }: { initial: TaskNavigation }) {
  const signals = useTaskSignals(BADGE_REFRESH_MS);
  if (signals.enabled === false) return null;
  const entry: NavigationEntry = {
    href: "/tasks",
    label: "Tasks",
    icon: <ListTodo strokeWidth={1.6} />,
  };
  const count = signals.needsYou ?? initial.needsYou ?? 0;
  const views = signals.latest === null ? initial.views : signals.views;
  return (
    <SidebarMenuItem>
      <Suspense fallback={<NavigationButton entry={entry} active={false} />}>
        <ActiveTasksButton entry={entry} />
      </Suspense>
      {count > 0 && (
        <SidebarMenuBadge>
          {count}
          <span className="sr-only"> need you</span>
        </SidebarMenuBadge>
      )}
      {views.length > 0 && (
        <SidebarMenuSub aria-label="Saved task views">
          {views.map((view) => (
            <SidebarMenuSubItem key={view.id}>
              <SidebarMenuSubButton asChild>
                <SidebarLink href={view.href}>
                  <span>{view.name}</span>
                </SidebarLink>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  );
}

function NavigationGroup({
  label,
  entries,
  action,
  className,
  children,
}: {
  label: string;
  entries: NavigationEntry[];
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
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
          {children}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function WorkspaceNavigation({
  stats,
  tasks,
}: {
  stats?: Stats;
  tasks?: TaskNavigation;
}) {
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
      >
        {tasks && <TasksNavigationItem initial={tasks} />}
      </NavigationGroup>
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
