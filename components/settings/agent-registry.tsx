import { Bot, Cpu, UserRound } from "lucide-react";
import Link from "next/link";
import { Fragment } from "react";
import { AgentAccessToggle } from "@/components/settings/agent-access-toggle";
import { AgentEditor } from "@/components/settings/agent-editor";
import { Badge } from "@/components/ui/badge";
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
import { Empty } from "@/components/workspace/primitives";
import { RelativeTime } from "@/components/workspace/relative-time";
import type { AgentKind } from "@/lib/tasks/types";
import {
  REGISTRY_CLAIMS_SHOWN,
  type RegistryAgent,
} from "@/lib/workspace/agent-registry";

const kinds: Record<AgentKind, { label: string; icon: typeof Bot }> = {
  owner: { label: "You", icon: UserRound },
  agent: { label: "Agent", icon: Bot },
  system: { label: "System", icon: Cpu },
};

const systemPurpose: Record<string, string> = {
  consolidator: "Nightly consolidation of your pages",
  task_keeper: "Nightly task keeper: extraction and hygiene suggestions",
};

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

function credentials(agent: RegistryAgent) {
  if (agent.kind === "owner") return "Your signed-in browser session";
  if (agent.kind === "system")
    return systemPurpose[agent.systemKey ?? ""] ?? "Nightly process";
  const active = agent.tokens.filter((token) => token.active).length;
  const parts = [];
  if (agent.tokens.length)
    parts.push(
      active === agent.tokens.length
        ? plural(active, "token")
        : `${plural(active, "active token")} of ${agent.tokens.length}`,
    );
  if (agent.clientIds.length)
    parts.push(plural(agent.clientIds.length, "OAuth client"));
  return parts.join(" · ") || "No credentials";
}

function claimPolicy(agent: RegistryAgent) {
  if (agent.claimOnRequest === true) return "Can claim on request";
  if (agent.claimOnRequest === false) return "Cannot claim on request";
  if (!agent.clientIds.length) return "Cannot claim on request (token default)";
  if (!agent.tokens.length) return "Can claim on request (OAuth default)";
  return "Claims on request in OAuth sessions, not with tokens";
}

function TaskRefs({ refs, label }: { refs: string[]; label: string }) {
  if (!refs.length) return null;
  const shown = refs.slice(0, REGISTRY_CLAIMS_SHOWN);
  return (
    <span>
      {label}{" "}
      {shown.map((ref, index) => (
        <Fragment key={ref}>
          {index > 0 && ", "}
          <Link
            href={`/tasks/${ref}`}
            className="font-mono whitespace-nowrap text-foreground underline-offset-4 hover:underline"
          >
            {ref}
          </Link>
        </Fragment>
      ))}
      {refs.length > shown.length && ` and ${refs.length - shown.length} more`}
    </span>
  );
}

/** Every agent that has connected, above the tokens that authenticate them. */
export function AgentRegistry({
  agents,
  tasks,
}: {
  agents: RegistryAgent[];
  /** Task policies and claims appear only while tasks are enabled. */
  tasks: boolean;
}) {
  if (!agents.length)
    return (
      <Empty
        icon={<Bot className="size-6" />}
        title="No agents yet."
        description="Agents appear here after their first write or task call, by token or OAuth."
      />
    );
  return (
    <ItemGroup className="border-t">
      {agents.map((agent, index) => {
        const kind = kinds[agent.kind];
        const Icon = kind.icon;
        const disabled = agent.disabledAt !== null;
        const policies = tasks && agent.kind === "agent";
        return (
          <Fragment key={agent.id}>
            {index > 0 && <ItemSeparator />}
            <Item role="listitem" className="items-start px-0">
              <ItemMedia>
                <Icon
                  className={`size-5 ${disabled ? "text-muted-foreground/60" : "text-muted-foreground"}`}
                />
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle className="flex-wrap break-words">
                  <span className={disabled ? "text-muted-foreground" : ""}>
                    {agent.label}
                  </span>
                  <Badge variant="secondary">{kind.label}</Badge>
                  {!agent.labelVerified && (
                    <Badge variant="outline">Unconfirmed name</Badge>
                  )}
                  {disabled && <Badge variant="outline">Disabled</Badge>}
                </ItemTitle>
                <ItemDescription>
                  {credentials(agent)}
                  {agent.kind !== "owner" && (
                    <>
                      {" · "}
                      {agent.lastSeenAt ? (
                        <>
                          Last seen <RelativeTime value={agent.lastSeenAt} />
                        </>
                      ) : (
                        "Never seen"
                      )}
                    </>
                  )}
                </ItemDescription>
                {agent.clientIds.length > 0 && (
                  <ItemDescription className="font-mono text-xs break-all">
                    {agent.clientIds.join(" · ")}
                  </ItemDescription>
                )}
                {policies && (
                  <>
                    <ItemDescription className="line-clamp-none text-xs">
                      {[
                        agent.createPolicy === "direct"
                          ? "Creates ready tasks for itself"
                          : "Creates tasks in triage",
                        agent.trustedCreator && agent.canBeTrustedCreator
                          ? "Trusted creator with its token"
                          : null,
                        claimPolicy(agent),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </ItemDescription>
                    {agent.capabilities.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {agent.capabilities.map((capability) => (
                          <Badge
                            key={capability}
                            variant="outline"
                            className="max-w-full font-mono font-normal whitespace-normal wrap-anywhere"
                          >
                            {capability}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </>
                )}
                {tasks &&
                  (agent.claims.length > 0 ||
                    agent.expiredClaims.length > 0) && (
                    <ItemDescription className="line-clamp-none flex flex-wrap gap-x-3 text-xs">
                      <TaskRefs refs={agent.claims} label="Holding" />
                      <TaskRefs
                        refs={agent.expiredClaims}
                        label="Lease expired on"
                      />
                    </ItemDescription>
                  )}
              </ItemContent>
              {agent.kind !== "system" && (
                <ItemActions>
                  <AgentEditor
                    agent={{
                      id: agent.id,
                      kind: agent.kind,
                      label: agent.label,
                      capabilities: agent.capabilities,
                      createPolicy: agent.createPolicy,
                      trustedCreator: agent.trustedCreator,
                      claimOnRequest: agent.claimOnRequest,
                      canBeTrustedCreator: agent.canBeTrustedCreator,
                    }}
                    tasks={tasks}
                  />
                  {agent.kind === "agent" && (
                    <AgentAccessToggle
                      id={agent.id}
                      label={agent.label}
                      disabled={disabled}
                    />
                  )}
                </ItemActions>
              )}
            </Item>
          </Fragment>
        );
      })}
    </ItemGroup>
  );
}
