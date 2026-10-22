"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type ComponentProps,
  type ReactNode,
  useState,
  useTransition,
} from "react";
import {
  refreshTasksAction,
  type TaskActionError,
  type TaskActionResult,
} from "@/app/(workspace)/actions/tasks";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { refreshTaskSignals } from "@/hooks/use-live-refresh";
import { cn } from "@/lib/utils";

/** Errors that mean the screen shows an older version of the task. */
const STALE_CODES = new Set([
  "TASK_VERSION_CONFLICT",
  "INVALID_TRANSITION",
  "TASK_NOT_FOUND",
  "SUGGESTION_NOT_FOUND",
  "LINK_NOT_FOUND",
]);

type ActionOutcome<T> = TaskActionResult<T> | TaskActionError | undefined;

/** Runs an owner action in a transition and keeps its typed error. */
export function useTaskAction() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<TaskActionError | null>(null);

  function run<T>(
    action: () => Promise<ActionOutcome<T>>,
    onSuccess?: (value: T) => void,
  ) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result && !result.ok) {
        setError(result);
        return;
      }
      // The action already refreshed this page; only the badge needs news.
      refreshTaskSignals({ silent: true });
      if (result?.ok) onSuccess?.(result.value);
    });
  }

  return { pending, error, run, clear: () => setError(null) };
}

/** An error with "Load latest version" when the task changed underneath. */
export function ActionError({
  error,
  className,
}: {
  error: TaskActionError | null;
  className?: string;
}) {
  const router = useRouter();
  const [loading, startTransition] = useTransition();
  if (!error) return null;
  const stale = STALE_CODES.has(error.code);
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-destructive",
        className,
      )}
    >
      <span className="min-w-0 wrap-anywhere">{error.message}</span>
      {stale && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0"
          disabled={loading}
          onClick={() =>
            startTransition(async () => {
              await refreshTasksAction();
              router.refresh();
            })
          }
        >
          {loading ? (
            <Spinner aria-hidden="true" className="size-3" />
          ) : (
            <RefreshCw size={13} aria-hidden="true" />
          )}
          Load latest version
        </Button>
      )}
    </div>
  );
}

/** A button bound to one owner action, with its own pending state and error. */
export function ActionButton<T>({
  action,
  children,
  pendingLabel,
  onSuccess,
  errorClassName,
  ...props
}: Omit<ComponentProps<typeof Button>, "onClick" | "action"> & {
  action: () => Promise<ActionOutcome<T>>;
  children: ReactNode;
  pendingLabel?: string;
  onSuccess?: (value: T) => void;
  errorClassName?: string;
}) {
  const { pending, error, run } = useTaskAction();
  return (
    <>
      <Button
        type="button"
        {...props}
        disabled={pending || props.disabled}
        onClick={() => run(action, onSuccess)}
      >
        {pending && <Spinner aria-hidden="true" />}
        {pending && pendingLabel ? pendingLabel : children}
      </Button>
      <ActionError error={error} className={errorClassName} />
    </>
  );
}
