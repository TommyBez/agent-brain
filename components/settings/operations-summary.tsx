import {
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { formatDate } from "@/components/brain-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { MaintenanceJob, OperationsData } from "@/lib/operations";

function OperationResult({ job }: { job: MaintenanceJob }) {
  const result = job.result;
  if (!result) return null;
  const counts: string[] = [];
  for (const [value, label] of [
    [result.writes, "successful writes"],
    [result.indexedPages ?? result.indexed, "pages indexed"],
    [result.embeddedChunks, "chunks embedded"],
    [result.remaining, "pages awaiting indexing"],
    [result.pages, "pages exported"],
    [result.links, "links exported"],
    [result.inputTokens, "input tokens"],
    [result.outputTokens, "output tokens"],
  ] as const) {
    if (typeof value === "number" && Number.isFinite(value)) {
      counts.push(`${value.toLocaleString()} ${label}`);
    }
  }
  const commitUrl =
    typeof result.repository === "string" &&
    /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(result.repository) &&
    typeof result.commit === "string" &&
    /^[a-f0-9]{40,64}$/.test(result.commit)
      ? `https://github.com/${result.repository}/commit/${result.commit}`
      : null;
  return (
    <div className="mt-2 space-y-2 text-xs text-muted-foreground">
      {counts.length > 0 && <p>{counts.join(" · ")}</p>}
      {(job.status === "partial" || result.budgetReached) && (
        <p>Run limit reached. Remaining work continues the next night.</p>
      )}
      {commitUrl && (
        <Button variant="link" asChild>
          <a href={commitUrl} target="_blank" rel="noreferrer">
            View export commit {result.commit?.slice(0, 7)}
            <ArrowUpRight />
          </a>
        </Button>
      )}
      {typeof result.report === "string" && result.report && (
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer font-medium text-foreground">
            Consolidation report
          </summary>
          <p className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap leading-relaxed">
            {result.report}
          </p>
        </details>
      )}
    </div>
  );
}

export function OperationsSummary({ data }: { data: OperationsData }) {
  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-xl font-semibold">Infrastructure</h2>
        <Badge variant={data.configured ? "default" : "secondary"}>
          {data.configured ? "Configured" : "Setup incomplete"}
        </Badge>
      </div>
      <Card>
        <CardContent className="divide-y">
          {data.checks.map((check) => (
            <div
              className="flex flex-wrap items-center gap-4 py-5 first:pt-0 last:pb-0"
              key={check.name}
            >
              {check.status === "ready" ? (
                <CheckCircle2 className="size-5 shrink-0 text-primary" />
              ) : (
                <XCircle className="size-5 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <h3 className="font-medium">{check.name}</h3>
                <p className="break-words text-sm text-muted-foreground">
                  {check.detail}
                </p>
              </div>
              <Badge
                variant={
                  check.status === "ready"
                    ? "default"
                    : check.status === "error"
                      ? "destructive"
                      : "secondary"
                }
                className="ml-auto capitalize"
              >
                {check.status === "missing" ? "Not configured" : check.status}
              </Badge>
            </div>
          ))}
        </CardContent>
      </Card>
      <section className="mt-8">
        <div className="mb-5 space-y-2">
          <h2 className="text-xl font-semibold">Recent maintenance</h2>
          <p className="text-sm text-muted-foreground">
            Vercel starts each night at 02:00 UTC. Run maintenance starts
            today's work or retries failures; completed work is kept.
          </p>
        </div>
        {data.jobs.length ? (
          <div className="divide-y border-t">
            {data.jobs.map((job) => (
              <div
                className="flex flex-wrap items-start justify-between gap-4 py-5"
                key={job.id}
              >
                <div className="min-w-0 flex-1">
                  <strong className="font-medium capitalize">
                    {job.kind.replaceAll("_", " ")}
                  </strong>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {formatDate(job.runDate || job.startedAt?.toISOString())}
                    {job.finishedAt &&
                      ` · Finished ${new Date(job.finishedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`}
                  </p>
                  {job.error && (
                    <p className="mt-2 break-words text-sm text-destructive">
                      {job.error}
                    </p>
                  )}
                  <OperationResult job={job} />
                </div>
                <Badge
                  variant={
                    ["completed", "success", "succeeded"].includes(job.status)
                      ? "default"
                      : job.status === "failed"
                        ? "destructive"
                        : "secondary"
                  }
                  className="capitalize"
                >
                  {job.status}
                </Badge>
              </div>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="flex items-center gap-4">
              <Clock3 className="size-6 shrink-0 text-muted-foreground" />
              <p className="text-sm">
                No maintenance has run yet.
                <br />
                <span className="text-muted-foreground">
                  Completed runs and errors will appear here.
                </span>
              </p>
            </CardContent>
          </Card>
        )}
      </section>
      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5 shrink-0" />
            Your knowledge has an exit door.
          </CardTitle>
          <CardDescription>
            Postgres is the source of truth. Git exports keep readable daily
            history; database snapshots protect the complete workspace.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="link" asChild>
            <a
              href="https://github.com/TommyBez/agent-brain#nightly-maintenance-export-and-backup"
              target="_blank"
              rel="noreferrer"
            >
              Operations guide <ArrowUpRight />
            </a>
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
