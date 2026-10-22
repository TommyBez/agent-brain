"use client";

import { Power, PowerOff } from "lucide-react";
import { useState, useTransition } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { setAgentDisabledAction } from "@/lib/workspace/settings-actions";

export function AgentAccessToggle({
  id,
  label,
  disabled,
}: {
  id: string;
  label: string;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const change = (next: boolean) => {
    setError("");
    startTransition(async () => {
      try {
        const result = await setAgentDisabledAction(id, next);
        if (result.error) setError(result.error);
        else setOpen(false);
      } catch {
        setError(
          next
            ? "Unable to disable this agent. Try again."
            : "Unable to enable this agent. Try again.",
        );
      }
    });
  };

  if (disabled)
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => change(false)}
        >
          {pending ? <Spinner aria-hidden="true" /> : <Power />}
          Enable
        </Button>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    );

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Disable ${label}`}
        >
          <PowerOff />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disable {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its tokens and OAuth sessions are refused from the next request. Its
            history stays, and tasks it holds can be released from the task. You
            can enable it again at any time.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep access</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              change(true);
            }}
          >
            Disable agent
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
