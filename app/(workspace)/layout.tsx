import { type ReactNode, Suspense } from "react";
import { Wordmark } from "@/components/wordmark";
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
    <div className="flex items-center gap-3 border-t px-2 pt-5">
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand"
      >
        {(user.name || user.email).slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <strong className="block truncate text-sm font-medium">
          {user.name || "Workspace owner"}
        </strong>
        <span
          className="block text-[11px] text-muted-foreground"
          title={user.email}
        >
          Personal workspace
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
            <div className="px-3">
              <Link
                className="inline-flex"
                href="/"
                aria-label="a native brain home"
              >
                <Wordmark />
              </Link>
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
