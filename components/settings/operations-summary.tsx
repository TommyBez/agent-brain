import { ArrowUpRight, CheckCircle2, ShieldCheck, XCircle } from "lucide-react";
import { formatDate } from "@/components/brain-types";
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
        <a
          href={commitUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
        >
          View export commit {result.commit?.slice(0, 7)}
          <ArrowUpRight size={12} />
        </a>
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
              <CheckCircle2 className="check-ready [color:#8da774]" size={21} />
            ) : (
              <XCircle className="check-missing [color:#c2ad72]" size={21} />
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
            <h2>Recent maintenance</h2>
            <p>
              Vercel starts each night at 02:00 UTC. Run maintenance starts
              today's work or retries failures; completed work is kept.
            </p>
          </div>
        </div>
        {data.jobs.length ? (
          <div className="jobs-list">
            {data.jobs.map((job) => (
              <div
                className="job-row flex justify-between items-start gap-5 p-[19px_12px] [border-top:1px_solid_var(--line)]"
                key={job.id}
              >
                <div className="min-w-0 flex-1">
                  <strong>{job.kind.replaceAll("_", " ")}</strong>
                  <p>
                    {formatDate(job.runDate || job.startedAt?.toISOString())}
                    {job.finishedAt &&
                      ` · Finished ${new Date(job.finishedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`}
                  </p>
                  {job.error && (
                    <p className="inline-error [color:#9e523a]!">{job.error}</p>
                  )}
                  <OperationResult job={job} />
                </div>
                <span
                  className={`check-status [font-size:9px] [text-transform:capitalize] rounded-[4px] [background:#edf1e4] [color:#8da277] p-[4px_8px] whitespace-nowrap status-${["completed", "success", "succeeded"].includes(job.status) ? "ready" : job.status === "failed" ? "error" : "missing"}`}
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
              No maintenance has run yet.
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
            href="https://github.com/TommyBez/agent-brain#nightly-maintenance-export-and-backup"
            target="_blank"
            rel="noreferrer"
          >
            Operations guide <ArrowUpRight size={14} />
          </a>
        </div>
      </div>
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
