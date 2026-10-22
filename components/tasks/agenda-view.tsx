import { CalendarClock, ChevronRight } from "lucide-react";
import Link from "next/link";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import type { Agenda, AgendaTask } from "@/lib/tasks/agenda";
import { formatTaskDate } from "@/lib/tasks/recurrences";
import { pageHref } from "@/lib/workspace/urls";
import { AgendaCopyButton } from "./agenda-copy-button";
import { AgendaSeriesPause } from "./agenda-series-form";
import { StatusBadge } from "./status";

// The agenda of one meeting series (§9): what is due by the next meeting,
// what is overdue, and what closed since the previous one.

function dueText(task: AgendaTask) {
  const parts: string[] = [];
  if (task.due.date) parts.push(`Due ${formatTaskDate(task.due.date)}`);
  if (task.due.text) parts.push(`“${task.due.text}”`);
  return parts.join(" · ");
}

function AgendaRow({ task, closed }: { task: AgendaTask; closed?: boolean }) {
  const details = [
    closed && task.closedAt
      ? `Closed ${formatTaskDate(task.closedAt.slice(0, 10))}`
      : dueText(task),
    task.leads.length ? `Lead: ${task.leads.join(", ")}` : "",
    task.title.untrusted ? `Written by ${task.title.authoredBy}` : "",
  ].filter(Boolean);
  return (
    <Item
      asChild
      className="rounded-none border-0 border-b px-5 py-4 last:border-b-0"
    >
      <Link href={`/tasks/${task.ref}`}>
        <ItemContent className="min-w-0">
          <ItemTitle className="wrap-anywhere">
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {task.ref}
            </span>
            <span>{task.title.value}</span>
          </ItemTitle>
          {details.length > 0 && (
            <ItemDescription className="wrap-anywhere">
              {details.join(" · ")}
            </ItemDescription>
          )}
        </ItemContent>
        <ItemActions>
          <StatusBadge status={task.status} />
          <ChevronRight size={16} aria-hidden="true" />
        </ItemActions>
      </Link>
    </Item>
  );
}

function AgendaSection({
  id,
  title,
  empty,
  tasks,
  closed,
}: {
  id: string;
  title: string;
  empty: string;
  tasks: AgendaTask[];
  closed?: boolean;
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h3 id={id} className="font-medium">
        {title}{" "}
        <span className="text-xs font-normal text-muted-foreground tabular-nums">
          {tasks.length}
        </span>
      </h3>
      {tasks.length ? (
        <ItemGroup className="overflow-hidden rounded-xl border bg-card">
          {tasks.map((task) => (
            <AgendaRow key={task.id} task={task} closed={closed} />
          ))}
        </ItemGroup>
      ) : (
        <p className="rounded-xl border border-dashed px-5 py-4 text-sm text-muted-foreground">
          {empty}
        </p>
      )}
    </section>
  );
}

export function AgendaView({
  agenda,
  markdown,
}: {
  agenda: Agenda;
  markdown: string;
}) {
  const { series } = agenda;
  const when = agenda.meeting
    ? `${formatTaskDate(agenda.meeting)}${series.time ? ` · ${series.time}` : ""}`
    : series.paused
      ? "Paused"
      : "No upcoming meeting";
  return (
    <article aria-labelledby="agenda-heading" className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4 rounded-2xl border bg-card px-5 py-5 sm:px-6">
        <div className="min-w-0 space-y-1.5">
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <CalendarClock size={14} aria-hidden="true" />
            {series.description}
          </p>
          <h2 id="agenda-heading" className="font-serif text-2xl wrap-anywhere">
            {series.title}
          </h2>
          <p className="text-sm">
            <span className="font-medium">Next meeting:</span> {when}
          </p>
          {series.project && (
            <p className="text-sm text-muted-foreground">
              Project:{" "}
              <Link
                href={pageHref(series.project.id)}
                className="underline-offset-4 hover:underline"
              >
                {series.project.title}
              </Link>
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AgendaSeriesPause id={series.id} paused={series.paused} />
          <AgendaCopyButton markdown={markdown} />
        </div>
      </header>
      <AgendaSection
        id="agenda-due"
        title="Due at this meeting"
        empty="Nothing is due by the next meeting."
        tasks={agenda.dueAtMeeting}
      />
      <AgendaSection
        id="agenda-overdue"
        title="Overdue"
        empty="Nothing is overdue."
        tasks={agenda.overdue}
      />
      <AgendaSection
        id="agenda-closed"
        title={
          agenda.previousMeeting
            ? `Closed since the last meeting (${formatTaskDate(agenda.previousMeeting)})`
            : "Closed since the series started"
        }
        empty="No task closed since then."
        tasks={agenda.closedSinceLast}
        closed
      />
    </article>
  );
}
