"use client";

import {
  ArrowUpRight,
  Bot,
  Check,
  CheckCircle2,
  Copy,
  KeyRound,
  LoaderCircle,
  Plus,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { authClient } from "@/lib/auth-client";
import { formatDate, request } from "./brain-types";
import { Empty, Loading } from "./brain-workspace";

type Token = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
};
export function AgentSettings({ endpoint }: { endpoint: string }) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [creating, setCreating] = useState(false);
  const [rawToken, setRawToken] = useState("");
  const [copied, setCopied] = useState("");
  const [writing, setWriting] = useState(false);
  const [scopes, setScopes] = useState(["brain:read", "brain:write"]);
  const [revoking, setRevoking] = useState<string | null>(null);
  useEffect(() => {
    request<{ tokens: Token[] }>("/api/agent-tokens")
      .then((data) => setTokens(data.tokens))
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : "Unable to load tokens.",
        ),
      )
      .finally(() => setBusy(false));
  }, []);
  async function copy(value: string, name: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(name);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      setError("Copy was unavailable. Select the text and copy it manually.");
    }
  }
  async function createToken(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWriting(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const data = await request<{ token: string; record: Token }>(
        "/api/agent-tokens",
        {
          method: "POST",
          body: JSON.stringify({
            name: form.get("name"),
            scopes,
            expiresInDays: Number(form.get("days")),
          }),
        },
      );
      setTokens([data.record, ...tokens]);
      setRawToken(data.token);
      setCreating(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to create token.",
      );
    } finally {
      setWriting(false);
    }
  }
  async function revoke(id: string) {
    setWriting(true);
    setError("");
    try {
      await request("/api/agent-tokens", {
        method: "DELETE",
        body: JSON.stringify({ id }),
      });
      setTokens(
        tokens.map((token) =>
          token.id === id
            ? { ...token, revokedAt: new Date().toISOString() }
            : token,
        ),
      );
      setRevoking(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to revoke token.",
      );
    } finally {
      setWriting(false);
    }
  }
  return (
    <>
      <div className="page-heading flex items-center justify-between gap-5 mb-[35px] min-[1600px]:mb-[45px] max-[740px]:mb-7 max-[460px]:gap-[10px]">
        <div>
          <span className="eyebrow [font-size:10px] font-semibold tracking-[.16em] text-primary">
            A SHARED PLACE TO REMEMBER
          </span>
          <h1>
            Agents & access
            <span className="heading-dot [color:#839567]">.</span>
          </h1>
          <p>Your knowledge, available wherever you think.</p>
        </div>
      </div>
      {error && (
        <p
          className="message [border:1px_solid_#d9dece] [background:#edf0e5] p-[16px_18px] rounded-[6px] [font-size:13px] m-[18px_0] error"
          role="alert"
        >
          {error}
        </p>
      )}
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
            <Button
              type="button"
              variant="ghost"
              className="icon-button bg-transparent w-[30px] h-[30px] rounded-[5px] inline-flex items-center justify-center text-muted-foreground shrink-0"
              aria-label="Copy MCP endpoint"
              onClick={() => copy(endpoint, "endpoint")}
            >
              {copied === "endpoint" ? <Check size={17} /> : <Copy size={17} />}
            </Button>
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
      <section className="settings-section mt-9">
        <div className="section-heading flex items-center justify-between gap-5 mb-5">
          <div>
            <h2>Headless agent tokens</h2>
            <p>
              Optional scoped tokens for scheduled jobs without browser sign-in.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="button bg-transparent [border:1px_solid_#d8dbcf] rounded-[6px] p-[10px_15px] inline-flex items-center justify-center gap-2 leading-[1.3] font-medium [font-size:12px] min-h-[39px] [transition:background_.15s,_border-color_.15s,_transform_.15s] whitespace-nowrap"
            onClick={() => {
              setCreating(!creating);
              setRawToken("");
            }}
          >
            <Plus size={15} /> New token
          </Button>
        </div>
        {rawToken && (
          <div className="token-reveal [border:1px_solid_#c8d9b0] p-[22px] rounded-[6px] [background:#edf5e1] mb-[22px]">
            <strong>Save your token now.</strong>
            <p>This is the only time the full token will be shown.</p>
            <div className="copy-field [border:1px_solid_#d2ddc0] rounded-[5px] [background:#fffef9] p-[9px_11px_9px_15px] flex items-center justify-between gap-[15px] m-[20px_0_15px] max-[460px]:pl-[10px]">
              <code>{rawToken}</code>
              <Button
                type="button"
                variant="ghost"
                className="icon-button bg-transparent w-[30px] h-[30px] rounded-[5px] inline-flex items-center justify-center text-muted-foreground shrink-0"
                aria-label="Copy new token"
                onClick={() => copy(rawToken, "token")}
              >
                {copied === "token" ? <Check size={17} /> : <Copy size={17} />}
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              className="text-link h-auto justify-start inline-flex items-center gap-[7px] p-[0] text-primary bg-transparent [font-size:12px] font-semibold text-left"
              onClick={() => setRawToken("")}
            >
              I have saved it <Check size={14} />
            </Button>
          </div>
        )}
        {creating && (
          <form
            className="token-form p-[22px] [border:1px_solid_#dce4cf] rounded-[6px] [background:#f4f7ed] mb-[22px]"
            onSubmit={createToken}
          >
            <div className="editor-fields grid grid-cols-[2fr_1fr] gap-[18px] mb-[23px]">
              <Label>
                Agent name
                <Input
                  name="name"
                  placeholder="e.g. Nightly consolidation"
                  maxLength={100}
                  required
                />
              </Label>
              <Label>
                Expires in
                <NativeSelect name="days" defaultValue="90">
                  <NativeSelectOption value="7">7 days</NativeSelectOption>
                  <NativeSelectOption value="30">30 days</NativeSelectOption>
                  <NativeSelectOption value="90">90 days</NativeSelectOption>
                  <NativeSelectOption value="365">365 days</NativeSelectOption>
                </NativeSelect>
              </Label>
            </div>
            <fieldset>
              <legend>Permissions</legend>
              {[
                {
                  value: "brain:read",
                  label: "Read",
                  help: "Search and retrieve knowledge",
                },
                {
                  value: "brain:write",
                  label: "Write",
                  help: "Create and update pages",
                },
                {
                  value: "brain:maintain",
                  label: "Maintain",
                  help: "Perform consolidation work",
                },
              ].map((scope) => (
                <Label
                  className="scope-option flex flex-row gap-2 items-start [font-size:9px] [color:#91a07e]"
                  key={scope.value}
                >
                  <Input
                    type="checkbox"
                    checked={scopes.includes(scope.value)}
                    onChange={(event) =>
                      setScopes(
                        event.target.checked
                          ? [...scopes, scope.value]
                          : scopes.filter((s) => s !== scope.value),
                      )
                    }
                  />
                  <span>
                    <strong>{scope.label}</strong>
                    {scope.help}
                  </span>
                </Label>
              ))}
            </fieldset>
            <div className="button-group flex gap-[10px] items-center">
              <Button
                type="submit"
                variant="default"
                className="button bg-transparent [border:1px_solid_#d8dbcf] rounded-[6px] p-[10px_15px] inline-flex items-center justify-center gap-2 leading-[1.3] font-medium [font-size:12px] min-h-[39px] [transition:background_.15s,_border-color_.15s,_transform_.15s] whitespace-nowrap primary"
                disabled={writing || !scopes.length}
              >
                {writing ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <KeyRound size={15} />
                )}{" "}
                Create token
              </Button>
              <Button
                type="button"
                variant="outline"
                className="button bg-transparent [border:1px_solid_#d8dbcf] rounded-[6px] p-[10px_15px] inline-flex items-center justify-center gap-2 leading-[1.3] font-medium [font-size:12px] min-h-[39px] [transition:background_.15s,_border-color_.15s,_transform_.15s] whitespace-nowrap"
                onClick={() => setCreating(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        {busy ? (
          <Loading />
        ) : tokens.length ? (
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
                      ? `Revoked ${formatDate(token.revokedAt)}`
                      : `Expires ${formatDate(token.expiresAt)} · Last used ${formatDate(token.lastUsedAt)}`}
                  </span>
                </div>
                {!token.revokedAt && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Revoke ${token.name}`}
                    onClick={() => setRevoking(token.id)}
                  >
                    <Trash2 size={16} />
                  </Button>
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
      </section>
      <AlertDialog
        open={Boolean(revoking)}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke agent access?</AlertDialogTitle>
            <AlertDialogDescription>
              This token will stop working immediately. You can create a new
              token whenever the agent needs access again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep token</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={writing}
              onClick={() => {
                if (revoking) void revoke(revoking);
              }}
            >
              Revoke token
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <PasswordSettings />
      <div className="headless-example [border-top:1px_solid_var(--line)] mt-[34px] pt-7">
        <h3>Headless connection</h3>
        <p>
          Send your token in the authorization header. Keep tokens in your
          agent’s secret store.
        </p>
        <pre>
          <code>{`POST ${endpoint || "https://your-domain/mcp"}\nAuthorization: Bearer <your-agent-token>\nContent-Type: application/json\nAccept: application/json, text/event-stream`}</code>
        </pre>
      </div>
    </>
  );
}

function PasswordSettings() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const result = await authClient.changePassword({
        currentPassword: String(fields.get("currentPassword")),
        newPassword: String(fields.get("newPassword")),
        revokeOtherSessions: true,
      });
      if (result.error)
        throw new Error(result.error.message || "Unable to change password.");
      form.reset();
      setSaved(true);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to change password.",
      );
    } finally {
      setBusy(false);
    }
  }
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
        <form onSubmit={changePassword} className="space-y-5">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Label
              htmlFor="current-password"
              className="flex flex-col items-start gap-2 text-xs"
            >
              Current password
              <Input
                id="current-password"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
              />
            </Label>
            <Label
              htmlFor="new-password"
              className="flex flex-col items-start gap-2 text-xs"
            >
              New password
              <Input
                id="new-password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                minLength={12}
                placeholder="At least 12 characters"
                required
              />
            </Label>
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          {saved && (
            <output className="block text-xs text-primary">
              Password changed. Other browser sessions have been signed out.
            </output>
          )}
          <Button type="submit" disabled={busy}>
            {busy ? (
              <LoaderCircle className="animate-spin" size={15} />
            ) : (
              <ShieldCheck size={15} />
            )}{" "}
            Update password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

type OperationData = {
  configured: boolean;
  checks: {
    name: string;
    status: "ready" | "missing" | "error";
    detail: string;
  }[];
  jobs: {
    kind: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    error: string | null;
  }[];
};
export function Operations() {
  const [data, setData] = useState<OperationData | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    request<OperationData>(`/api/operations?refresh=${reload}`, {
      signal: controller.signal,
    })
      .then(setData)
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to read operations.",
          );
      });
    return () => controller.abort();
  }, [reload]);
  return (
    <>
      <div className="page-heading flex items-center justify-between gap-5 mb-[35px] min-[1600px]:mb-[45px] max-[740px]:mb-7 max-[460px]:gap-[10px]">
        <div>
          <span className="eyebrow [font-size:10px] font-semibold tracking-[.16em] text-primary">
            TAKE CARE OF WHAT YOU KNOW
          </span>
          <h1>
            Operations<span className="heading-dot [color:#839567]">.</span>
          </h1>
          <p>Storage, safeguards, and the work that happens overnight.</p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="button bg-transparent [border:1px_solid_#d8dbcf] rounded-[6px] p-[10px_15px] inline-flex items-center justify-center gap-2 leading-[1.3] font-medium [font-size:12px] min-h-[39px] [transition:background_.15s,_border-color_.15s,_transform_.15s] whitespace-nowrap"
          onClick={() => setReload((n) => n + 1)}
        >
          Refresh status
        </Button>
      </div>
      {error ? (
        <p
          className="message [border:1px_solid_#d9dece] [background:#edf0e5] p-[16px_18px] rounded-[6px] [font-size:13px] m-[18px_0] error"
          role="alert"
        >
          {error}
        </p>
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <div className="section-heading flex items-center justify-between gap-5 mb-5">
            <h2>Infrastructure</h2>
            <span
              className={`type-tag inline-flex gap-[5px] items-center [justify-self:start] [font-size:9px] p-[3px_8px] rounded-[4px] [background:#ebeee3] [color:#768566] [text-transform:capitalize] whitespace-nowrap max-[460px]:[font-size:8px] max-[460px]:p-[3px_6px] ${data.configured ? "type-project" : "type-decision"}`}
            >
              {data.configured ? "Configured" : "Setup incomplete"}
            </span>
          </div>
          <div className="operation-checks [border:1px_solid_var(--line)] rounded-[6px]">
            {data.checks.map((check) => (
              <div
                className="operation-check flex items-center gap-[18px] p-[23px] [border-bottom:1px_solid_var(--line)] max-[960px]:p-[18px] max-[960px]:gap-[13px] max-[460px]:gap-3 max-[460px]:flex-wrap"
                key={check.name}
              >
                {check.status === "ready" ? (
                  <CheckCircle2
                    className="check-ready [color:#8da774]"
                    size={21}
                  />
                ) : (
                  <XCircle
                    className="check-missing [color:#c2ad72]"
                    size={21}
                  />
                )}
                <div>
                  <h3>{check.name}</h3>
                  <p>{check.detail}</p>
                </div>
                <span
                  className={`check-status [font-size:9px] [text-transform:capitalize] rounded-[4px] [background:#edf1e4] [color:#8da277] p-[4px_8px] whitespace-nowrap status-${check.status}`}
                >
                  {check.status === "missing" ? "Not configured" : check.status}
                </span>
              </div>
            ))}
          </div>
          <section className="settings-section mt-9">
            <div className="section-heading flex items-center justify-between gap-5 mb-5">
              <div>
                <h2>Recent scheduled jobs</h2>
                <p>Actual runs, recorded by your infrastructure.</p>
              </div>
            </div>
            {data.jobs.length ? (
              <div className="jobs-list">
                {data.jobs.map((job, index) => (
                  <div
                    className="job-row flex justify-between items-center gap-5 p-[19px_12px] [border-top:1px_solid_var(--line)]"
                    key={`${job.kind}-${job.startedAt}-${index}`}
                  >
                    <div>
                      <strong>{job.kind.replaceAll("_", " ")}</strong>
                      <p>
                        {formatDate(job.startedAt)}
                        {job.finishedAt &&
                          ` · Finished ${new Date(job.finishedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`}
                      </p>
                      {job.error && (
                        <p className="inline-error [color:#9e523a]!">
                          {job.error}
                        </p>
                      )}
                    </div>
                    <span
                      className={`check-status [font-size:9px] [text-transform:capitalize] rounded-[4px] [background:#edf1e4] [color:#8da277] p-[4px_8px] whitespace-nowrap status-${job.status === "completed" || job.status === "success" ? "ready" : job.status === "failed" ? "error" : "missing"}`}
                    >
                      {job.status}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="quiet-empty flex items-center gap-[17px] p-[30px_25px] [border:1px_solid_var(--line)] rounded-[6px] [color:#92a27c]">
                <ClockGlyph />
                <p>
                  No scheduled jobs have run yet.
                  <br />
                  <span>Completed runs and errors will appear here.</span>
                </p>
              </div>
            )}
          </section>
          <div className="ownership-note flex gap-[18px] p-7 [background:#f0f4e7] [border:1px_solid_#e2e9d7] rounded-[6px] mt-[37px] max-[460px]:p-5 max-[460px]:gap-[14px]">
            <ShieldCheck size={25} strokeWidth={1.3} />
            <div>
              <h3>Your knowledge has an exit door.</h3>
              <p>
                Postgres is the source of truth. Git exports keep readable daily
                history; database snapshots protect the complete workspace.
              </p>
              <a
                className="text-link h-auto justify-start inline-flex items-center gap-[7px] p-[0] text-primary bg-transparent [font-size:12px] font-semibold text-left"
                href="https://github.com/TommyBez/agent-brain#operations"
                target="_blank"
                rel="noreferrer"
              >
                Operations guide <ArrowUpRight size={14} />
              </a>
            </div>
          </div>
        </>
      )}
    </>
  );
}
function ClockGlyph() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="14" cy="14" r="11" stroke="currentColor" />
      <path d="M14 7v7l4 3" stroke="currentColor" />
    </svg>
  );
}
