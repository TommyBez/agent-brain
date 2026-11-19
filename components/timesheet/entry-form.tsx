"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteTimeEntryAction,
  saveTimeEntryAction,
} from "@/lib/timesheet/actions";
import { timesheetDayLabel } from "@/lib/timesheet/calendar";
import { formatDuration, type TimeEntry } from "@/lib/timesheet/schemas";

export type ProjectChoice = { id: string; title: string };

type EntryFormProps = {
  projects: ProjectChoice[];
  date: string;
  projectId?: string;
  entry?: TimeEntry;
};

export function EntryDialog({
  projects,
  date,
  projectId,
  entry,
  compact = false,
}: EntryFormProps & { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant={entry || compact ? "ghost" : "default"}
          size={entry || compact ? "icon" : "default"}
          aria-label={
            entry
              ? "Edit entry"
              : compact
                ? `Log time for ${timesheetDayLabel(date)}`
                : undefined
          }
          title={
            entry ? "Edit entry" : compact ? "Log time for this day" : undefined
          }
        >
          {entry ? <Pencil /> : <Plus />}
          {!entry && !compact && "Log time"}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[460px]"
        showCloseButton={!pending}
      >
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl">
            {entry ? "Edit time entry" : "Log time"}
          </DialogTitle>
          <DialogDescription>{timesheetDayLabel(date)}</DialogDescription>
        </DialogHeader>
        <EntryForm
          key={entry?.version}
          projects={projects}
          date={date}
          projectId={projectId}
          entry={entry}
          pending={pending}
          startTransition={startTransition}
          onClose={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function EntryForm({
  projects,
  date,
  projectId,
  entry,
  pending,
  startTransition,
  onClose,
}: EntryFormProps & {
  pending: boolean;
  startTransition: React.TransitionStartFunction;
  onClose: () => void;
}) {
  const prefix = useId();
  const router = useRouter();
  const [error, setError] = useState("");
  // Retain the key after transport failures so the same submission can be retried.
  const key = useRef<string | null>(null);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        const form = new FormData(event.currentTarget);
        const minutes =
          Number(form.get("hours")) * 60 + Number(form.get("minutes"));
        if (minutes < 1 || minutes > 1440) {
          setError("Enter a duration between 1 minute and 24 hours.");
          return;
        }
        const patch = {
          workedOn: form.get("workedOn"),
          minutes,
          note: form.get("note"),
          projectRef: form.get("projectRef") || null,
        };
        if (!entry) key.current ??= crypto.randomUUID();
        const input = entry
          ? { id: entry.id, expectedVersion: entry.version, patch }
          : { ...patch, idempotencyKey: key.current };
        setError("");
        startTransition(async () => {
          try {
            const result = await saveTimeEntryAction(input, Boolean(entry));
            if (result.error) {
              setError(result.error);
              return;
            }
            key.current = null;
            onClose();
            toast.success(entry ? "Time entry updated" : "Time logged");
            router.refresh();
          } catch {
            setError("Unable to confirm the save. Retry with the same values.");
          }
        });
      }}
    >
      <fieldset disabled={pending} className="min-w-0 space-y-5">
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-date`}>Date</Label>
          <Input
            id={`${prefix}-date`}
            name="workedOn"
            type="date"
            required
            defaultValue={date}
          />
        </div>
        <fieldset className="grid min-w-0 grid-cols-2 gap-3">
          <legend className="mb-2 text-sm font-medium">Duration</legend>
          <div className="relative">
            <Input
              aria-label="Hours"
              name="hours"
              type="number"
              min="0"
              max="24"
              step="1"
              required
              className="pr-16 tabular-nums"
              defaultValue={entry ? Math.floor(entry.minutes / 60) : 1}
            />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-xs text-muted-foreground"
            >
              hours
            </span>
          </div>
          <div className="relative">
            <Input
              aria-label="Minutes"
              name="minutes"
              type="number"
              min="0"
              max="59"
              step="1"
              required
              className="pr-16 tabular-nums"
              defaultValue={entry ? entry.minutes % 60 : 0}
            />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-xs text-muted-foreground"
            >
              min
            </span>
          </div>
        </fieldset>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-project`}>
            Project{" "}
            <span className="font-normal text-muted-foreground">
              (optional)
            </span>
          </Label>
          <NativeSelect
            id={`${prefix}-project`}
            name="projectRef"
            defaultValue={(entry ? entry.projectId : projectId) ?? ""}
          >
            <NativeSelectOption value="">No project</NativeSelectOption>
            {entry?.projectId &&
              !projects.some((project) => project.id === entry.projectId) && (
                <NativeSelectOption value={entry.projectId}>
                  {entry.projectTitle} (reclassified)
                </NativeSelectOption>
              )}
            {projects.map((project) => (
              <NativeSelectOption key={project.id} value={project.id}>
                {project.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-note`}>
            Note{" "}
            <span className="font-normal text-muted-foreground">
              (optional)
            </span>
          </Label>
          <Textarea
            id={`${prefix}-note`}
            name="note"
            rows={3}
            maxLength={2000}
            placeholder="What did you work on?"
            defaultValue={entry?.note ?? ""}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 border-t pt-4">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">
            {pending ? "Saving…" : entry ? "Save changes" : "Log time"}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

export function DeleteEntry({ entry }: { entry: TimeEntry }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) {
          setError("");
          setOpen(next);
        }
      }}
    >
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Delete entry"
          title="Delete entry"
        >
          <Trash2 />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete time entry?</AlertDialogTitle>
          <AlertDialogDescription>
            Remove {formatDuration(entry.minutes)} logged on{" "}
            {timesheetDayLabel(entry.workedOn)}.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => {
              setError("");
              startTransition(async () => {
                try {
                  const result = await deleteTimeEntryAction({
                    id: entry.id,
                    expectedVersion: entry.version,
                  });
                  if (result.error) {
                    setError(result.error);
                    return;
                  }
                  setOpen(false);
                  toast.success("Time entry deleted");
                  router.refresh();
                } catch {
                  setError(
                    "Unable to confirm deletion. Refresh to check the entry before retrying.",
                  );
                }
              });
            }}
          >
            {pending ? "Deleting…" : "Delete entry"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
