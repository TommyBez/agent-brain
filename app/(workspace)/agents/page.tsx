import { KeyRound } from "lucide-react";
import { Suspense } from "react";
import {
  AgentConnection,
  HeadlessConnection,
} from "@/components/brain-settings";
import { formatDate } from "@/components/brain-types";
import { PasswordSettings } from "@/components/settings/password-settings";
import { TokenCreator } from "@/components/settings/token-creator";
import { TokenRevoke } from "@/components/settings/token-revoke";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Empty, Loading, PageHeading } from "@/components/workspace/primitives";
import { listAgentTokens } from "@/lib/agent-tokens";
import { mcpResource } from "@/lib/auth";
import { getWorkspaceUser } from "@/lib/workspace/session";

export const metadata = { title: "Agents & access — Brain" };

export default function AgentsPage() {
  const endpoint = mcpResource();
  return (
    <>
      <PageHeading
        eyebrow="A SHARED PLACE TO REMEMBER"
        title="Agents & access"
        description="Your knowledge, available wherever you think."
      />
      <AgentConnection endpoint={endpoint} />
      <section className="mt-8">
        <div className="mb-5 space-y-2">
          <h2 className="text-xl font-semibold">Headless agent tokens</h2>
          <p className="text-sm text-muted-foreground">
            Optional scoped tokens for scheduled jobs without browser sign-in.
          </p>
        </div>
        <Suspense fallback={<Loading />}>
          <AgentTokens />
        </Suspense>
      </section>
      <Suspense fallback={<Loading />}>
        <OwnerPassword />
      </Suspense>
      <HeadlessConnection endpoint={endpoint} />
    </>
  );
}

async function AgentTokens() {
  const user = await getWorkspaceUser();
  const tokens = await listAgentTokens(user.id);
  return (
    <>
      <TokenCreator />
      {tokens.length ? (
        <div className="divide-y border-t">
          {tokens.map((token) => (
            <div
              className={`flex flex-wrap items-center gap-4 py-5 ${token.revokedAt ? "opacity-50" : ""}`}
              key={token.id}
            >
              <KeyRound className="size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 space-y-1">
                <strong className="flex flex-wrap items-center gap-3 break-words font-medium">
                  {token.name}
                  <span className="font-mono text-xs font-normal text-muted-foreground">
                    {token.prefix}…
                  </span>
                </strong>
                <p className="text-sm text-muted-foreground">
                  {token.scopes.join(" · ")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {token.revokedAt
                    ? `Revoked ${formatDate(token.revokedAt.toISOString())}`
                    : `Expires ${formatDate(token.expiresAt?.toISOString())} · Last used ${formatDate(token.lastUsedAt?.toISOString())}`}
                </p>
              </div>
              {!token.revokedAt && (
                <TokenRevoke id={token.id} name={token.name} />
              )}
            </div>
          ))}
        </div>
      ) : (
        <Empty
          icon={<KeyRound className="size-6" />}
          title="Your agents have a place here."
          description="Create a token when an agent needs to connect without an interactive sign-in."
        />
      )}
    </>
  );
}

async function OwnerPassword() {
  await getWorkspaceUser();
  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>Your password</CardTitle>
        <CardDescription>
          Change your sign-in password and end your other browser sessions.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <PasswordSettings />
      </CardContent>
    </Card>
  );
}
