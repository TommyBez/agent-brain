"use client";

import { Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { purgeTaskAction } from "@/app/(workspace)/actions/tasks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { ActionError, useTaskAction } from "./action-state";

/** Physical deletion, confirmed by typing the reference back. */
export function PurgeForm({ taskRef }: { taskRef: string }) {
  const id = useId();
  const [typed, setTyped] = useState("");
  const { pending, error, run } = useTaskAction();
  const confirmed = typed.trim().toUpperCase() === taskRef.toUpperCase();
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (confirmed) run(() => purgeTaskAction(taskRef, typed.trim()));
      }}
    >
      <Label htmlFor={id}>
        Type {taskRef} to delete it with its history, links and participants
      </Label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={id}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
          className="w-40"
          aria-describedby={`${id}-help`}
        />
        <Button
          type="submit"
          variant="destructive"
          disabled={!confirmed || pending}
        >
          {pending ? (
            <Spinner aria-hidden="true" />
          ) : (
            <Trash2 aria-hidden="true" />
          )}
          Purge {taskRef}
        </Button>
      </div>
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        Only a text-free record with the number remains. A purged extraction
        never returns from the task keeper. Closed tasks already exported stay
        in the Git history.
      </p>
      <ActionError error={error} />
    </form>
  );
}
