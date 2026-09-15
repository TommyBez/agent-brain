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
      <section className="settings-section mt-9">
        <div className="section-heading flex items-center justify-between gap-5 mb-5">
          <div>
            <h2>Headless agent tokens</h2>
            <p>
              Optional scoped tokens for scheduled jobs without browser sign-in.
            </p>
          </div>
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
        <div className="token-list">
          {tokens.map((token) => (
            <div
              className={`token-row [border-top:1px_solid_var(--line)] p-[20px_5px] flex items-center gap-4 max-[460px]:gap-[10px] max-[460px]:flex-wrap ${token.revokedAt ? "is-revoked" : ""}`}
              key={token.id}
            >
              <KeyRound size={18} />
              <div>
                <strong>
                  {token.name}
                  <span className="token-prefix [font-size:9px] [font-family:var(--mono)] [color:#a0ad90] font-normal">
                    {token.prefix}…
                  </span>
                </strong>
                <p>{token.scopes.join(" · ")}</p>
                <span>
                  {token.revokedAt
                    ? `Revoked ${formatDate(token.revokedAt.toISOString())}`
                    : `Expires ${formatDate(token.expiresAt?.toISOString())} · Last used ${formatDate(token.lastUsedAt?.toISOString())}`}
                </span>
              </div>
              {!token.revokedAt && (
                <TokenRevoke id={token.id} name={token.name} />
              )}
            </div>
          ))}
        </div>
      ) : (
        <Empty
          icon={<KeyRound size={25} />}
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
    <Card className="mt-8 gap-5 rounded-md bg-background shadow-none">
      <CardHeader>
        <CardTitle className="font-[family-name:var(--serif)] text-2xl font-normal">
          Your password
        </CardTitle>
        <CardDescription className="text-xs">
          Change your sign-in password and end your other browser sessions.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <PasswordSettings />
      </CardContent>
    </Card>
  );
}
