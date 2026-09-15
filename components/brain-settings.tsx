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
              <ShieldCheck className="size-4 shrink-0" /> OAuth 2.1 + PKCE
            </span>
            <span>Streamable HTTP</span>
            <span>Cloud reachable</span>
          </div>
        </CardContent>
      </Card>
      <ol className="my-6 grid gap-6 border-b pb-6 sm:grid-cols-3">
        <li className="space-y-2">
          <span className="font-mono text-sm text-muted-foreground">01</span>
          <h3 className="font-medium">Read before</h3>
          <p className="text-sm text-muted-foreground">
            Resolve the entity and retrieve context before beginning work.
          </p>
        </li>
        <li className="space-y-2">
          <span className="font-mono text-sm text-muted-foreground">02</span>
          <h3 className="font-medium">Write after</h3>
          <p className="text-sm text-muted-foreground">
            Save what matters, with sources and meaningful connections.
          </p>
        </li>
        <li className="space-y-2">
          <span className="font-mono text-sm text-muted-foreground">03</span>
          <h3 className="font-medium">Reflect at night</h3>
          <p className="text-sm text-muted-foreground">
            Give your scheduled agent the consolidation procedure.
          </p>
        </li>
      </ol>
    </>
  );
}

export function HeadlessConnection({ endpoint }: { endpoint: string }) {
  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>Headless connection</CardTitle>
        <CardDescription>
          Send your token in the authorization header. Keep tokens in your
          agent’s secret store.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <pre className="overflow-x-auto rounded-md border bg-muted p-4 font-mono text-sm">
          <code>{`POST ${endpoint || "https://your-domain/mcp"}\nAuthorization: Bearer <your-agent-token>\nContent-Type: application/json\nAccept: application/json, text/event-stream`}</code>
        </pre>
      </CardContent>
    </Card>
  );
}
