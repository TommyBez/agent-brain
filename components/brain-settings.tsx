import { Bot, ShieldCheck } from "lucide-react";
import { CopyButton } from "@/components/settings/copy-button";

export function AgentConnection({ endpoint }: { endpoint: string }) {
  return (
    <>
      <section className="connection-card flex gap-[26px] p-[33px] [border:1px_solid_#d8e2c8] rounded-[7px] [background:#f0f4e8] max-[960px]:p-[23px] max-[960px]:gap-[18px] max-[740px]:gap-[17px] max-[460px]:p-[22px_18px]">
        <span className="connection-icon [background:#e3ebd5] [color:#83986b] w-[62px] h-[62px] shrink-0 rounded-[17px] flex items-center justify-center max-[960px]:h-[46px] max-[960px]:w-[46px] max-[960px]:rounded-[12px] max-[460px]:hidden">
          <Bot size={26} strokeWidth={1.5} />
        </span>
        <div>
          <span className="eyebrow [font-size:10px] font-semibold tracking-[.16em] text-primary">
            REMOTE MCP
          </span>
          <h2>Connect with OAuth</h2>
          <p>
            Add this URL as a remote MCP server and choose OAuth when your agent
            asks for authentication. Sign in to Brain, review the requested
            permissions, and approve the connection.
          </p>
          <div className="copy-field [border:1px_solid_#d2ddc0] rounded-[5px] [background:#fffef9] p-[9px_11px_9px_15px] flex items-center justify-between gap-[15px] m-[20px_0_15px] max-[460px]:pl-[10px]">
            <code>{endpoint}</code>
            <CopyButton value={endpoint} label="Copy MCP endpoint" />
          </div>
          <div className="connection-details flex gap-5 flex-wrap [color:#8d9f78] [font-size:9px] max-[460px]:gap-3 max-[460px]:[font-size:8px]">
            <span>
              <ShieldCheck size={14} /> OAuth 2.1 + PKCE
            </span>
            <span>Streamable HTTP</span>
            <span>Cloud reachable</span>
          </div>
        </div>
      </section>
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
