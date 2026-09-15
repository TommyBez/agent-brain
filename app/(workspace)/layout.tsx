import { type ReactNode, Suspense } from "react";
import {
  SettingsNavigation,
  WorkspaceNavigation,
} from "@/components/workspace/navigation";
import {
  WorkspaceLink as Link,
  SearchNavigationProvider,
} from "@/components/workspace/search-navigation";
import {
  FindKnowledge,
  SignOutButton,
  WorkspaceShell,
} from "@/components/workspace/shell";
import { getWorkspaceStats } from "@/lib/workspace/data";
import { getWorkspaceUser } from "@/lib/workspace/session";

async function NavigationCounts() {
  return <WorkspaceNavigation stats={await getWorkspaceStats()} />;
}

async function OwnerProfile() {
  const user = await getWorkspaceUser();
  return (
    <div className="flex items-center gap-3 border-t pt-4">
      <div className="min-w-0 flex-1">
        <strong className="block truncate text-sm font-medium">
          {user.name || "Workspace owner"}
        </strong>
        <span
          className="block truncate text-xs text-muted-foreground"
          title={user.email}
        >
          {user.email}
        </span>
      </div>
      <SignOutButton />
    </div>
  );
}

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <SearchNavigationProvider>
      <WorkspaceShell
        sidebar={
          <>
            <div className="space-y-2">
              <Link
                className="font-serif text-3xl font-semibold"
                href="/"
                aria-label="Brain home"
              >
                brain
              </Link>
              <p className="text-sm text-muted-foreground">Personal brain</p>
            </div>
            <FindKnowledge />
            <Suspense fallback={<WorkspaceNavigation />}>
              <NavigationCounts />
            </Suspense>
            <div className="mt-auto space-y-4 pt-6">
              <SettingsNavigation />
              <Suspense
                fallback={
                  <div
                    className="border-t pt-4 text-sm text-muted-foreground"
                    aria-busy="true"
                  >
                    Opening your workspace…
                  </div>
                }
              >
                <OwnerProfile />
              </Suspense>
            </div>
          </>
        }
      >
        {children}
      </WorkspaceShell>
    </SearchNavigationProvider>
  );
}
