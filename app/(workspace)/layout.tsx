import { type ReactNode, Suspense } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarRail,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CommandMenuProvider } from "@/components/workspace/command-menu";
import {
  SettingsNavigation,
  type TaskNavigation,
  WorkspaceNavigation,
} from "@/components/workspace/navigation";
import {
  OwnerMenu,
  WorkspaceBrand,
  WorkspaceHeader,
  WorkspaceSidebarProvider,
} from "@/components/workspace/shell";
import { tasksEnabled } from "@/lib/tasks/types";
import { getWorkspaceStats } from "@/lib/workspace/data";
import { getWorkspaceUser } from "@/lib/workspace/session";
import { queryNeedsYouCount } from "@/lib/workspace/task-queries";
import { savedViewHref } from "@/lib/workspace/task-urls";
import { getTaskSettingsView } from "@/lib/workspace/tasks-data";

const TASKS_PENDING: TaskNavigation = { needsYou: null, views: [] };

// The badge poll's own query, authorized here and read fresh: the layout
// renders on a full load or refresh, and the poll keeps it current after.
async function getTaskNavigation(): Promise<TaskNavigation> {
  const user = await getWorkspaceUser();
  const [needsYou, settings] = await Promise.all([
    queryNeedsYouCount(user.id),
    getTaskSettingsView(),
  ]);
  return {
    needsYou,
    views: settings.savedViews.map((view) => ({
      id: view.id,
      name: view.name,
      href: savedViewHref(view.query),
    })),
  };
}

async function NavigationCounts({ tasks }: { tasks: boolean }) {
  const [stats, taskNavigation] = await Promise.all([
    getWorkspaceStats(),
    tasks ? getTaskNavigation() : undefined,
  ]);
  return <WorkspaceNavigation stats={stats} tasks={taskNavigation} />;
}

async function OwnerProfile() {
  const user = await getWorkspaceUser();
  return <OwnerMenu name={user.name} email={user.email} />;
}

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const tasks = tasksEnabled();
  return (
    <TooltipProvider>
      <WorkspaceSidebarProvider>
        <CommandMenuProvider tasks={tasks}>
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
          >
            Skip to content
          </a>
          <Sidebar collapsible="icon">
            <SidebarHeader>
              <WorkspaceBrand />
            </SidebarHeader>
            <SidebarContent>
              <Suspense
                fallback={
                  <WorkspaceNavigation
                    tasks={tasks ? TASKS_PENDING : undefined}
                  />
                }
              >
                <NavigationCounts tasks={tasks} />
              </Suspense>
              <SettingsNavigation />
            </SidebarContent>
            <SidebarFooter>
              <Suspense
                fallback={
                  <output
                    aria-label="Opening your workspace"
                    className="flex h-12 items-center gap-2 p-2"
                  >
                    <Skeleton className="size-8 shrink-0 rounded-full" />
                    <Skeleton className="h-4 flex-1 group-data-[collapsible=icon]:hidden" />
                  </output>
                }
              >
                <OwnerProfile />
              </Suspense>
            </SidebarFooter>
            <SidebarRail />
          </Sidebar>
          <SidebarInset className="min-w-0">
            <WorkspaceHeader />
            <div
              id="main-content"
              className="mx-auto w-full max-w-[1360px] px-5 pt-8 pb-20 md:px-10 md:pt-12 xl:px-14"
            >
              {children}
            </div>
          </SidebarInset>
        </CommandMenuProvider>
      </WorkspaceSidebarProvider>
    </TooltipProvider>
  );
}
