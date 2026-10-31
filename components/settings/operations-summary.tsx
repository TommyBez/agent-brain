import { ArrowUpRight, ChevronDown, Clock3, ShieldCheck } from "lucide-react";
import { Fragment } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item";
import { formatDate } from "@/lib/formatters";
import type { TaskPhaseHalt } from "@/lib/maintenance/task-phase";
import type { MaintenanceJob, OperationsData } from "@/lib/operations";
import { TaskMaintenanceControl } from "./operations-controls";

const JOB_LABELS: Record<MaintenanceJob["kind"], string> = {
  consolidation: "Consolidation",
  embeddings: "Embeddings",
  export: "Export",
  task_keeper: "Task keeper",
  task_links: "Task links",
};

const TASK_COUNTERS = {
  task_keeper: [
    ["pagesConsidered", "pages considered"],
    ["created", "tasks added to triage"],
    ["newSources", "new sources suggested"],
    ["suggestions", "suggestions opened"],
    ["occurrences", "recurring tasks created"],
    ["unitsReused", "analyses reused"],
    ["requests", "model requests"],
    ["remainingPages", "pages awaiting the next run"],
    ["oversizedPages", "pages too long to analyze"],
    ["cappedPages", "pages waiting for a free suggestion slot"],
    ["cappedSuggestions", "suggestions waiting for a free slot"],
  ],
  task_links: [
    ["tasksConsidered", "tasks considered"],
    ["suggested", "links suggested"],
    ["retracted", "links retracted"],
    ["unitsReused", "analyses reused"],
    ["requests", "Jev requests"],
    ["remainingTasks", "tasks awaiting the next run"],
  ],
} as const;

// Shown only when there is something to report.
const HIDDEN_WHEN_ZERO = new Set<string>([
  "remainingPages",
  "remainingTasks",
  "oversizedPages",
  "cappedPages",
  "cappedSuggestions",
]);

const HALT_NOTICES: Record<TaskPhaseHalt, string> = {
  budget: "Daily task budget reached. Remaining work continues the next night.",
  provider:
    "A model provider stopped this pass. Remaining work continues the next night.",
  embeddings:
    "Task embeddings were unavailable. Remaining work continues the next night.",
  limit: "Run limit reached. Remaining work continues the next night.",
};

const CONSOLIDATION_NOTICES: Record<string, string> = {
  budget:
    "Daily consolidation budget reached. Pending work continues in a later run.",
  provider:
    "Repeated provider failures stopped this run. Pending work has been retained.",
  incomplete:
    "Some tasks could not finish because of technical errors. Pending work has been retained.",
  limit: "Run limit reached. Pending work continues in a later run.",
  changed:
    "Pages changed during this run. A later pass will use their updated contents.",
  capacity:
    "Some tasks exceed the model's input capacity. They will be retried when their evidence or capacity policy changes.",
};

const spend = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});

function counted(value: unknown, label: string) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toLocaleString()} ${label}`
    : null;
}

function OperationResult({ job }: { job: MaintenanceJob }) {
  const result = job.result;
  if (!result) return null;
  const values: Record<string, unknown> = result;
  const taskPhase =
    job.kind === "task_keeper" || job.kind === "task_links" ? job.kind : null;
  const counts = (
    taskPhase
      ? TASK_COUNTERS[taskPhase].map(([key, label]) =>
          HIDDEN_WHEN_ZERO.has(key) && values[key] === 0
            ? null
            : counted(values[key], label),
        )
      : (
          [
            [result.writes, "successful writes"],
            [values.evaluatedTasks, "tasks analyzed"],
            [values.reusedTasks, "analyses reused"],
            [values.remainingTasks, "tasks queued"],
            [values.capacityLimited, "capacity limits"],
            [values.unresolved, "uncertain findings"],
            [values.errors, "technical errors"],
            [result.indexedPages, "pages indexed"],
            [result.embeddedChunks, "chunks embedded"],
            [result.remaining, "pages awaiting indexing"],
            [result.pages, "pages exported"],
            [result.links, "links exported"],
            [result.tasks, "closed tasks exported"],
            [result.inputTokens, "input tokens"],
            [result.outputTokens, "output tokens"],
          ] as const
        ).map(([value, label]) => counted(value, label))
  ).filter((count): count is string => count !== null);
  if (
    taskPhase &&
    typeof values.spendNano === "number" &&
    Number.isFinite(values.spendNano) &&
    values.spendNano > 0
  )
    counts.push(`${spend.format(values.spendNano / 1e9)} spent`);
  const halt =
    job.kind === "consolidation" &&
    typeof values.stoppedBy === "string" &&
    Object.hasOwn(CONSOLIDATION_NOTICES, values.stoppedBy)
      ? CONSOLIDATION_NOTICES[values.stoppedBy]
      : typeof values.halt === "string" &&
          Object.hasOwn(HALT_NOTICES, values.halt)
        ? HALT_NOTICES[values.halt as TaskPhaseHalt]
        : null;
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
      {halt ? (
        <p>{halt}</p>
      ) : (
        (job.status === "partial" || result.budgetReached) && (
          <p>Run limit reached. Remaining work continues the next night.</p>
        )
      )}
      {job.kind === "consolidation" &&
        typeof values.capacityLimited === "number" &&
        values.capacityLimited > 0 &&
        values.stoppedBy !== "capacity" && (
          <p>{CONSOLIDATION_NOTICES.capacity}</p>
        )}
      {job.kind === "export" && result.skipped === true && (
        <p>Export skipped. This account has no Git repository configured.</p>
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
        <Collapsible className="rounded-md border p-3">
          <CollapsibleTrigger className="group/trigger flex w-full items-center justify-between font-medium text-foreground">
            Consolidation report
            <ChevronDown
              size={14}
              className="text-muted-foreground transition-transform group-data-open/trigger:rotate-180"
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap leading-relaxed">
              {result.report}
            </p>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

export function OperationsSummary({
  data,
  tasks,
}: {
  data: OperationsData;
  // The owner's task manager switch: "Run now" for the task phases.
  tasks: boolean;
}) {
  return (
    <>
      <section>
        <div className="mb-5 space-y-2">
          <h2 className="text-xl font-semibold">Recent maintenance</h2>
          <p className="text-sm text-muted-foreground">
            Vercel starts each night at 02:00 UTC. Run maintenance requests a
            new consolidation pass, even after today's work has finished. If a
            run is already active, it continues without starting another.
          </p>
        </div>
        {tasks && <TaskMaintenanceControl />}
        {data.jobs.length ? (
          <ItemGroup className="border-t">
            {data.jobs.map((job, index) => (
              <Fragment key={job.id}>
                {index > 0 && <ItemSeparator />}
                <Item role="listitem" className="items-start px-0">
                  <ItemContent className="min-w-0">
                    <ItemTitle>{JOB_LABELS[job.kind] ?? job.kind}</ItemTitle>
                    <ItemDescription>
                      {formatDate(job.runDate)}
                      {job.finishedAt &&
                        ` · Finished ${new Date(job.finishedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`}
                    </ItemDescription>
                    {job.error && (
                      <p className="mt-1 break-words text-sm text-destructive">
                        {job.error}
                      </p>
                    )}
                    <OperationResult job={job} />
                  </ItemContent>
                  <ItemActions>
                    <Badge
                      variant={
                        job.status === "succeeded"
                          ? "default"
                          : job.status === "failed"
                            ? "destructive"
                            : "secondary"
                      }
                      className="capitalize"
                    >
                      {job.status}
                    </Badge>
                  </ItemActions>
                </Item>
              </Fragment>
            ))}
          </ItemGroup>
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
            Export & recovery
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
