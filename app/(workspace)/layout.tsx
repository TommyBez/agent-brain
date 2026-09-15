import { ArrowUpRight, Bot } from "lucide-react";
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
    <div className="profile flex items-center gap-[9px] border-t border-[#dce1d1] mt-[19px] p-[19px_1px_21px]">
      <div className="profile-avatar size-[29px] shrink-0 rounded-full bg-[#e0e5d5] text-[#6d7e5d] [font-family:var(--serif)] flex items-center justify-center text-[15px]">
        {user.name.slice(0, 1).toUpperCase() || "B"}
      </div>
      <div>
        <strong>{user.name || "Workspace owner"}</strong>
        <span title={user.email}>{user.email}</span>
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
            <Link
              className="wordmark flex items-center gap-[11px] [font-family:var(--serif)] text-[31px] font-semibold tracking-[-1.2px]"
              href="/"
              aria-label="Brain home"
            >
              <span className="brand-mark inline-flex size-[37px] rounded-[11px] bg-primary items-center justify-center text-background [font-family:var(--serif)] text-[34px] leading-none pb-[6px] tracking-[-3px] pr-[3px]">
                b.
              </span>
              brain
            </Link>
            <div className="workspace-name flex items-center gap-[9px] p-[12px_10px] border border-[#dbdfd0] rounded-[6px] bg-[#f6f6f0] mb-[22px] max-[960px]:p-[10px_7px] max-[960px]:gap-[6px]">
              <span className="workspace-monogram size-[29px] rounded-[6px] flex items-center justify-center bg-[#e4e9db] text-primary [font-family:var(--serif)] text-[17px]">
                B
              </span>
              <div>
                <strong>Personal brain</strong>
                <span>Your private knowledge</span>
              </div>
              <span
                className="status-dot size-[6px] rounded-full bg-[#7c916b] inline-block shrink-0"
                title="Private workspace"
              />
            </div>
            <FindKnowledge />
            <Suspense fallback={<WorkspaceNavigation />}>
              <NavigationCounts />
            </Suspense>
            <div className="sidebar-bottom mt-auto pt-[35px] max-[1200px]:pt-[22px]">
              <div className="agent-note border border-[#dbe0d1] rounded-[6px] p-[16px_13px] bg-[#eaeedf] m-[0_4px_22px] max-[1200px]:hidden">
                <span className="agent-note-icon block text-[#778b62] mb-[9px]">
                  <Bot size={18} />
                </span>
                <strong>Made to think together.</strong>
                <p>Give your agent a place to remember.</p>
                <Link
                  className="text-link inline-flex items-center gap-[7px] text-primary text-xs font-semibold"
                  href="/agents"
                >
                  Connect an agent
                  <ArrowUpRight size={14} />
                </Link>
              </div>
              <SettingsNavigation />
              <Suspense
                fallback={
                  <div
                    className="profile mt-[19px] py-5 text-xs text-muted-foreground"
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
