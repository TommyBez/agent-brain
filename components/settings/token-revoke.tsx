"use client";

import { Trash2 } from "lucide-react";
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
import { revokeTokenAction } from "@/lib/workspace/settings-actions";

export function TokenRevoke({ id, name }: { id: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Revoke ${name}`}
        >
          <Trash2 />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke agent access?</AlertDialogTitle>
          <AlertDialogDescription>
            This token will stop working immediately. You can create a new token
            whenever the agent needs access again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep token</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              setError("");
              startTransition(async () => {
                try {
                  const result = await revokeTokenAction(id);
                  if (result.error) setError(result.error);
                  else setOpen(false);
                } catch {
                  setError("Unable to revoke token. Try again.");
                }
              });
            }}
          >
            Revoke token
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
