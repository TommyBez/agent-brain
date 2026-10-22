import { KeyRound } from "lucide-react";
import { cache, Fragment, Suspense } from "react";
import {
  AgentConnection,
  HeadlessConnection,
} from "@/components/brain-settings";
import { AgentRegistry } from "@/components/settings/agent-registry";
import { PasswordSettings } from "@/components/settings/password-settings";
import {
  TaskManagerToggle,
  TaskManagerToggleFallback,
} from "@/components/settings/task-manager-toggle";
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
import {
  agentRegistry,
  tokenAgentChoices,
} from "@/lib/workspace/agent-registry";
import { getWorkspaceUser } from "@/lib/workspace/session";
import { getTasksEnabled } from "@/lib/workspace/tasks-data";

export const metadata = { title: "Agents & access · a native brain" };

// Read fresh on every request, once per render for both sections.
const loadRegistry = cache((ownerId: string) => agentRegistry(ownerId));

export default function AgentsPage() {
  const endpoint = mcpResource();
  return (
    <>
      <PageHeading
        eyebrow="Settings"
        title="Agents & access"
        description="Connect your agents and manage access to your workspace."
      />
      <section className="mb-8">
        <div className="mb-5 space-y-2">
          <h2 className="text-xl font-semibold">Task manager</h2>
          <p className="text-sm text-muted-foreground">
            Off by default. When it is on, you and your agents can create, claim
            and track tasks.
          </p>
        </div>
        <Suspense fallback={<TaskManagerToggleFallback />}>
          <TaskManager />
        </Suspense>
      </section>
      <AgentConnection endpoint={endpoint} />
      <section className="mt-8">
        <div className="mb-5 space-y-2">
          <h2 className="text-xl font-semibold">Agent registry</h2>
          <p className="text-sm text-muted-foreground">
            Every agent that has written to your brain or used tasks, with its
            credentials. Changes apply from its next request.
          </p>
        </div>
        <Suspense fallback={<Loading />}>
          <Registry />
        </Suspense>
      </section>
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

// The owner's setting needs the session, so it is read below Suspense.
async function TaskManager() {
  return <TaskManagerToggle enabled={await getTasksEnabled()} />;
}

async function Registry() {
  const user = await getWorkspaceUser();
  const [agents, tasks] = await Promise.all([
    loadRegistry(user.id),
    getTasksEnabled(),
  ]);
  return <AgentRegistry agents={agents} tasks={tasks} />;
}

async function AgentTokens() {
  const user = await getWorkspaceUser();
  const [tokens, agents] = await Promise.all([
    listAgentTokens(user.id),
    loadRegistry(user.id),
  ]);
  const agentLabels = new Map(agents.map((agent) => [agent.id, agent.label]));
  return (
    <>
      <TokenCreator agents={tokenAgentChoices(agents)} />
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
                  <ItemDescription>
                    {[
                      token.agentId && agentLabels.get(token.agentId)
                        ? `Agent: ${agentLabels.get(token.agentId)}`
                        : null,
                      token.scopes.join(" · "),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </ItemDescription>
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
