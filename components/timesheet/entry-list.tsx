import { FolderOpen } from "lucide-react";
import Link from "next/link";
import { timesheetDayLabel } from "@/lib/timesheet/calendar";
import { formatDuration, type TimeEntry } from "@/lib/timesheet/schemas";
import { pageHref } from "@/lib/workspace/urls";
import { DeleteEntry, EntryDialog, type ProjectChoice } from "./entry-form";

function EntryRow({
  entry,
  projects,
}: {
  entry: TimeEntry;
  projects: ProjectChoice[];
}) {
  return (
    <li className="flex items-start gap-2 px-4 py-3 sm:px-5">
      <div className="min-w-0 flex-1 pt-1">
        <div className="flex items-start gap-2 text-sm font-medium">
          <FolderOpen
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
          {entry.projectId ? (
            <Link
              href={pageHref(entry.projectId)}
              className="min-w-0 wrap-anywhere underline-offset-4 hover:underline"
            >
              {entry.projectTitle}
            </Link>
          ) : (
            <span className="text-muted-foreground">No project</span>
          )}
        </div>
        {entry.note && (
          <p className="mt-1.5 text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap text-muted-foreground">
            {entry.note}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center">
        <span className="px-1 pt-1 text-sm font-semibold tabular-nums sm:mr-1 sm:pt-0">
          {formatDuration(entry.minutes)}
        </span>
        <div className="flex text-muted-foreground">
          <EntryDialog
            entry={entry}
            projects={projects}
            date={entry.workedOn}
          />
          <DeleteEntry entry={entry} />
        </div>
      </div>
    </li>
  );
}

export function EntryList({
  entries,
  projects,
}: {
  entries: TimeEntry[];
  projects: ProjectChoice[];
}) {
  return (
    <ul className="divide-y">
      {entries.map((entry) => (
        <EntryRow key={entry.id} entry={entry} projects={projects} />
      ))}
    </ul>
  );
}

export function EntriesByDay({
  entries,
  projects,
}: {
  entries: TimeEntry[];
  projects: ProjectChoice[];
}) {
  const groups = new Map<string, TimeEntry[]>();
  for (const entry of entries) {
    const day = groups.get(entry.workedOn);
    if (day) day.push(entry);
    else groups.set(entry.workedOn, [entry]);
  }
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      {Array.from(groups, ([date, dayEntries]) => (
        <section key={date} className="border-b last:border-b-0">
          <h3 className="border-b bg-muted/50 px-4 py-2.5 text-sm font-medium sm:px-5">
            <time dateTime={date}>
              {timesheetDayLabel(date)} {date.slice(0, 4)}
            </time>
          </h3>
          <EntryList entries={dayEntries} projects={projects} />
        </section>
      ))}
    </div>
  );
}
