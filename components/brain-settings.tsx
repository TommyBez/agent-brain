import { ShieldCheck } from "lucide-react";
import { CopyButton } from "@/components/settings/copy-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function AgentConnection({ endpoint }: { endpoint: string }) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardDescription>REMOTE MCP</CardDescription>
          <CardTitle>Connect with OAuth</CardTitle>
          <CardDescription>
            Add this URL as a remote MCP server and choose OAuth when your agent
            asks for authentication. Sign in to Brain, review the requested
            permissions, and approve the connection.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={endpoint}
              aria-label="MCP endpoint"
              className="font-mono"
            />
            <CopyButton value={endpoint} label="Copy MCP endpoint" />
          </div>
          <div className="flex gap-5 flex-wrap text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <ShieldCheck size={14} /> OAuth 2.1 + PKCE
            </span>
            <span>Streamable HTTP</span>
            <span>Cloud reachable</span>
          </div>
        </CardContent>
      </Card>
      <div className="agent-procedure grid grid-cols-[repeat(3,1fr)] p-[32px_0] m-[0_0_20px] [border-bottom:1px_solid_var(--line)] gap-[30px] max-[960px]:gap-[15px] max-[740px]:gap-5 max-[460px]:grid-cols-[1fr] max-[460px]:gap-5 max-[460px]:p-[25px_3px]">
        <div>
          <span>01</span>
          <strong>Read before</strong>
          <p>Resolve the entity and retrieve context before beginning work.</p>
        </div>
        <div>
          <span>02</span>
          <strong>Write after</strong>
          <p>Save what matters, with sources and meaningful connections.</p>
        </div>
        <div>
          <span>03</span>
          <strong>Reflect at night</strong>
          <p>Give your scheduled agent the consolidation procedure.</p>
        </div>
      </div>
    </>
  );
}

export function HeadlessConnection({ endpoint }: { endpoint: string }) {
  return (
    <div className="headless-example [border-top:1px_solid_var(--line)] mt-[34px] pt-7">
      <h3>Headless connection</h3>
      <p>
        Send your token in the authorization header. Keep tokens in your agent’s
        secret store.
      </p>
      <pre>
        <code>{`POST ${endpoint || "https://your-domain/mcp"}\nAuthorization: Bearer <your-agent-token>\nContent-Type: application/json\nAccept: application/json, text/event-stream`}</code>
      </pre>
    </div>
  );
}
