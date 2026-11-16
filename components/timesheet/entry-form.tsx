"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
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
import type { TimeEntry } from "@/lib/timesheet/schemas";

export type ProjectChoice = { id: string; title: string };

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function EntryForm({
  projects,
  entry,
  onDone,
}: {
  projects: ProjectChoice[];
  entry?: TimeEntry;
  onDone?: () => void;
}) {
  const prefix = useId();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  // Retain the key after transport failures; reset only after confirmed success.
  const key = useRef<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={formRef}
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const patch = {
          workedOn: form.get("workedOn"),
          minutes: Number(form.get("hours")) * 60 + Number(form.get("minutes")),
          note: form.get("note"),
          projectRef: form.get("projectRef") || null,
        };
        key.current ??= crypto.randomUUID();
        const input = entry
          ? { id: entry.id, expectedVersion: entry.version, patch }
          : { ...patch, idempotencyKey: key.current };
        setError("");
        setSaved(false);
        startTransition(async () => {
          try {
            const result = await saveTimeEntryAction(input, Boolean(entry));
            if (result.error) {
              setError(result.error);
              return;
            }
            key.current = null;
            formRef.current?.reset();
            setSaved(true);
            router.refresh();
            onDone?.();
          } catch {
            setError("Unable to confirm the save. Retry with the same values.");
          }
        });
      }}
    >
      <fieldset disabled={pending} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-date`}>Date</Label>
            <Input
              id={`${prefix}-date`}
              name="workedOn"
              type="date"
              required
              defaultValue={entry?.workedOn}
              ref={(node) => {
                if (node && !node.defaultValue) node.defaultValue = today();
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-hours`}>Hours</Label>
            <Input
              id={`${prefix}-hours`}
              name="hours"
              type="number"
              min="0"
              max="24"
              step="1"
              required
              defaultValue={entry ? Math.floor(entry.minutes / 60) : 1}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${prefix}-minutes`}>Minutes</Label>
            <Input
              id={`${prefix}-minutes`}
              name="minutes"
              type="number"
              min="0"
              max="59"
              step="1"
              required
              defaultValue={entry ? entry.minutes % 60 : 0}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-project`}>Project (optional)</Label>
          <NativeSelect
            id={`${prefix}-project`}
            name="projectRef"
            defaultValue={entry?.projectId ?? ""}
          >
            <NativeSelectOption value="">No project</NativeSelectOption>
            {projects.map((project) => (
              <NativeSelectOption key={project.id} value={project.id}>
                {project.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-note`}>Note (optional)</Label>
          <Textarea
            id={`${prefix}-note`}
            name="note"
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
        {saved && (
          <output className="text-sm text-muted-foreground">Time saved.</output>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : entry ? "Save changes" : "Log time"}
          </Button>
          {onDone && (
            <Button type="button" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          )}
        </div>
      </fieldset>
    </form>
  );
}

export function EntryActions({
  entry,
  projects,
}: {
  entry: TimeEntry;
  projects: ProjectChoice[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  if (editing)
    return (
      <div className="mt-4">
        <EntryForm
          key={entry.version}
          entry={entry}
          projects={projects}
          onDone={() => setEditing(false)}
        />
      </div>
    );
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => {
          setEditing(true);
          setConfirming(false);
        }}
      >
        Edit
      </Button>
      {confirming ? (
        <>
          <span className="text-sm text-muted-foreground">
            Delete this entry?
          </span>
          <Button
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setError("");
                try {
                  const result = await deleteTimeEntryAction({
                    id: entry.id,
                    expectedVersion: entry.version,
                  });
                  if (result.error) setError(result.error);
                  else {
                    setConfirming(false);
                    router.refresh();
                  }
                } catch {
                  setError(
                    "Unable to confirm deletion. Refresh to check the entry before retrying.",
                  );
                }
              })
            }
          >
            {pending ? "Deleting…" : "Confirm delete"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
        </>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
          Delete
        </Button>
      )}
      {error && (
        <p role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
