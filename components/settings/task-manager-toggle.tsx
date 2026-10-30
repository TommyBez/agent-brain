"use client";

import { useId, useOptimistic, useState, useTransition } from "react";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { setTasksEnabledAction } from "@/lib/workspace/settings-actions";

const label = "Use the task manager";
const description =
  "Turning it off hides tasks, their agent tools and the nightly task phases. Nothing is deleted.";
const box = "rounded-md border p-4";

/**
 * The owner's task manager switch. It moves at once; the server render that
 * follows the action confirms it, and a refused change falls back by itself.
 */
export function TaskManagerToggle({ enabled }: { enabled: boolean }) {
  const id = useId();
  const [checked, setChecked] = useOptimistic(enabled);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");

  const change = (next: boolean) => {
    setError("");
    startTransition(async () => {
      setChecked(next);
      try {
        const result = await setTasksEnabledAction(next);
        if ("error" in result) setError(result.error);
      } catch {
        setError(
          next
            ? "Unable to turn on the task manager. Try again."
            : "Unable to turn off the task manager. Try again.",
        );
      }
    });
  };

  return (
    <Field orientation="horizontal" className={box} aria-busy={pending}>
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription id={`${id}-description`}>
          {description}
        </FieldDescription>
        {error && <FieldError>{error}</FieldError>}
      </FieldContent>
      <Switch
        id={id}
        checked={checked}
        disabled={pending}
        aria-describedby={`${id}-description`}
        onCheckedChange={change}
      />
    </Field>
  );
}

/** The same row while the owner's setting is read, without a guessed state. */
export function TaskManagerToggleFallback() {
  return (
    <Field orientation="horizontal" className={box} aria-busy="true">
      <FieldContent>
        <FieldTitle>{label}</FieldTitle>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <Skeleton className="h-[18.4px] w-8 shrink-0 rounded-full" />
    </Field>
  );
}
