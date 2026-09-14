import { headers } from "next/headers";
import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { BrainWorkspace } from "@/components/brain-workspace";
import { getSession, isAuthConfigured, mcpResource } from "@/lib/auth";

async function Workspace() {
  if (!isAuthConfigured()) return <AuthGate configured={false} />;
  const session = await getSession(await headers());
  if (!session) return <AuthGate configured />;
  return (
    <BrainWorkspace
      name={session.user.name}
      email={session.user.email}
      mcpEndpoint={mcpResource()}
    />
  );
}

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="opening min-h-[100vh] flex flex-col items-center justify-center gap-5 text-muted-foreground">
          <span className="brand-mark inline-flex w-[37px] h-[37px] rounded-[11px] bg-primary items-center justify-center text-background [font-family:var(--serif)] [font-size:34px] leading-[1] pb-[6px] tracking-[-3px] pr-[3px]">
            b.
          </span>
          <p>Opening your brain…</p>
        </div>
      }
    >
      <Workspace />
    </Suspense>
  );
}
