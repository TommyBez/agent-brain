"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { isTimesheetDate, timesheetHref } from "@/lib/timesheet/calendar";

const empty = { from: "", to: "", project: "" };

export function TimesheetFilters({
  view,
  date,
  project,
  from = "",
  to = "",
  projects,
}: {
  view: "calendar" | "list";
  date: string | null;
  project: string;
  from?: string;
  to?: string;
  projects: { id: string; title: string; type: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [committed, setCommitted] = useState({ from, to, project });
  const [draft, setDraft] = useState(committed);

  // Synchronize deep links and history navigation without remounting the inputs.
  const datesChanged = from !== committed.from || to !== committed.to;
  const projectChanged = project !== committed.project;
  if (datesChanged || projectChanged) {
    setCommitted({ from, to, project });
    setDraft({
      from: datesChanged ? from : draft.from,
      to: datesChanged ? to : draft.to,
      project: projectChanged ? project : draft.project,
    });
  }

  function apply(next: typeof empty) {
    startTransition(() => {
      router.replace(timesheetHref({ view, date, ...next }), { scroll: false });
    });
  }

  function changeDates(next: typeof empty) {
    setDraft(next);
    if (!dateError(next.from, next.to)) apply(next);
  }

  const error = dateError(draft.from, draft.to);
  const projectSelect = (
    <NativeSelect
      id="timesheet-project"
      name="project"
      aria-label={view === "calendar" ? "Filter by project" : undefined}
      value={draft.project}
      onChange={(event) => {
        const next = { ...draft, project: event.target.value };
        setDraft(next);
        apply(error ? { ...next, from, to } : next);
      }}
    >
      <NativeSelectOption value="">All projects</NativeSelectOption>
      <NativeSelectOption value="none">No project</NativeSelectOption>
      {projects.map((option) => (
        <NativeSelectOption key={option.id} value={option.id}>
          {option.title}
          {option.type !== "project" ? " (reclassified)" : ""}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );

  const status = (
    <output className="sr-only">
      {pending ? "Updating time entries…" : ""}
    </output>
  );
  if (view === "calendar") {
    return (
      <div className="w-40 min-w-0 max-w-full sm:w-52">
        {projectSelect}
        {status}
      </div>
    );
  }

  return (
    <section
      aria-label="Timesheet filters"
      className="grid grid-cols-2 items-end gap-3 rounded-xl border bg-card p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)_auto]"
    >
      <div className="min-w-0 space-y-2">
        <Label htmlFor="timesheet-from">From</Label>
        <Input
          id="timesheet-from"
          name="from"
          type="date"
          value={draft.from}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "timesheet-date-error" : undefined}
          onChange={(event) =>
            changeDates({ ...draft, from: event.target.value })
          }
        />
      </div>
      <div className="min-w-0 space-y-2">
        <Label htmlFor="timesheet-to">To</Label>
        <Input
          id="timesheet-to"
          name="to"
          type="date"
          value={draft.to}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "timesheet-date-error" : undefined}
          onChange={(event) =>
            changeDates({ ...draft, to: event.target.value })
          }
        />
      </div>
      <div className="col-span-2 min-w-0 space-y-2 lg:col-span-1">
        <Label htmlFor="timesheet-project">Project</Label>
        {projectSelect}
      </div>
      {(draft.from || draft.to || draft.project) && (
        <Button
          type="button"
          variant="ghost"
          className="w-fit"
          onClick={() => changeDates(empty)}
        >
          Reset
        </Button>
      )}
      {error && (
        <p
          id="timesheet-date-error"
          role="alert"
          className="col-span-full text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {status}
    </section>
  );
}

function dateError(from: string, to: string) {
  if ((from && !isTimesheetDate(from)) || (to && !isTimesheetDate(to))) {
    return "Enter a valid date.";
  }
  if (from && to && from > to) {
    return "The end date must be on or after the start date.";
  }
}
