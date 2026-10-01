import { KeyRound } from "lucide-react";
import { Fragment, Suspense } from "react";
import {
  AgentConnection,
  HeadlessConnection,
} from "@/components/brain-settings";
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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item";
import { Empty, Loading, PageHeading } from "@/components/workspace/primitives";
import { listAgentTokens } from "@/lib/agent-tokens";
import { mcpResource } from "@/lib/auth";
import { formatDate } from "@/lib/formatters";
import { getWorkspaceUser } from "@/lib/workspace/session";

export const metadata = { title: "Agents & access · a native brain" };

export default function AgentsPage() {
  const endpoint = mcpResource();
  return (
    <>
      <PageHeading
        eyebrow="Settings"
        title="Agents & access"
        description="Connect your agents and manage access to your workspace."
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
        <ItemGroup className="border-t">
          {tokens.map((token, index) => (
            <Fragment key={token.id}>
              {index > 0 && <ItemSeparator />}
              <Item
                role="listitem"
                className={`px-0 ${token.revokedAt ? "opacity-50" : ""}`}
              >
                <ItemMedia>
                  <KeyRound className="size-5 text-muted-foreground" />
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle className="flex-wrap break-words">
                    {token.name}
                    <span className="font-mono text-xs font-normal text-muted-foreground">
                      {token.prefix}…
                    </span>
                  </ItemTitle>
                  <ItemDescription>{token.scopes.join(" · ")}</ItemDescription>
                  <ItemDescription className="text-xs">
                    {token.revokedAt
                      ? `Revoked ${formatDate(token.revokedAt.toISOString())}`
                      : `Expires ${formatDate(token.expiresAt?.toISOString())} · Last used ${formatDate(token.lastUsedAt?.toISOString())}`}
                  </ItemDescription>
                </ItemContent>
                {!token.revokedAt && (
                  <ItemActions>
                    <TokenRevoke id={token.id} name={token.name} />
                  </ItemActions>
                )}
              </Item>
            </Fragment>
          ))}
        </ItemGroup>
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
