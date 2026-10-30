"use client";

import { Check, FileText, Pencil, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import {
  approveTasksAction,
  taskOperationAction,
} from "@/app/(workspace)/actions/tasks";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { TriageBatch as Batch } from "@/lib/workspace/task-queries";
import { taskEditHref, taskHref } from "@/lib/workspace/task-urls";
import { pageHref } from "@/lib/workspace/urls";
import { ActionButton, ActionError, useTaskAction } from "./action-state";
import { dueLabel } from "./labels";
import { AuthoredBy, PriorityLabel, StatusBadge } from "./status";

function RejectButton({
  taskRef,
  version,
  extracted,
}: {
  taskRef: string;
  version: number;
  extracted: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const { pending, error, run } = useTaskAction();
  if (!confirming)
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => setConfirming(true)}
      >
        <X aria-hidden="true" /> Reject
      </Button>
    );
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="destructive"
        disabled={pending}
        onClick={() =>
          run(() =>
            taskOperationAction(taskRef, "reject", {
              expectedVersion: version,
            }),
          )
        }
      >
        {pending && <Spinner aria-hidden="true" />}
        {extracted ? "Reject for good" : "Confirm reject"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => setConfirming(false)}
      >
        Keep
      </Button>
      <ActionError error={error} className="basis-full" />
    </span>
  );
}

/** One source's extracted tasks, or one agent's unapproved tasks. */
export function TriageBatch({ batch }: { batch: Batch }) {
  const [result, setResult] = useState<{
    approved: string[];
    failed: { ref: string; message: string }[];
  } | null>(null);
  const heading = batch.source
    ? `${batch.source.title} · version ${batch.source.version}`
    : `Created by ${batch.createdBy.label}`;
  const extracted = batch.batchId !== null;
  return (
    <section
      aria-label={heading}
      className="overflow-hidden rounded-xl border bg-card"
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3 sm:px-5">
        <FileText
          size={17}
          aria-hidden="true"
          className="shrink-0 text-muted-foreground"
        />
        <div className="min-w-0 flex-1">
          <h3 className="font-medium wrap-anywhere">
            {batch.source ? (
              <Link
                href={pageHref(batch.source.id)}
                className="hover:underline"
              >
                {heading}
              </Link>
            ) : (
              heading
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            {batch.tasks.length}{" "}
            {extracted
              ? batch.tasks.length === 1
                ? "task extracted"
                : "tasks extracted"
              : batch.tasks.length === 1
                ? "task waiting for approval"
                : "tasks waiting for approval"}
          </p>
        </div>
        {batch.tasks.length > 1 && (
          <ActionButton
            size="sm"
            pendingLabel="Approving…"
            errorClassName="basis-full"
            action={() =>
              approveTasksAction(
                batch.tasks.map((task) => ({
                  ref: task.ref,
                  expectedVersion: task.version,
                })),
              )
            }
            onSuccess={setResult}
          >
            <Check aria-hidden="true" /> Approve all
          </ActionButton>
        )}
      </header>
      {result && result.failed.length > 0 && (
        <div role="alert" className="border-b px-5 py-3 text-sm">
          <p>
            Approved {result.approved.length}; {result.failed.length} could not
            be approved:
          </p>
          <ul className="mt-1 list-disc pl-5 text-destructive">
            {result.failed.map((failure) => (
              <li key={failure.ref}>
                {failure.ref}: {failure.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ul className="divide-y">
        {batch.tasks.map((task) => {
          const due = dueLabel(task.due);
          return (
            <li key={task.id} className="space-y-2 px-4 py-4 sm:px-5">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {task.ref}
                </span>
                <Link
                  href={taskHref(task.ref)}
                  className="min-w-0 font-medium wrap-anywhere hover:underline"
                >
                  {task.title.value}
                </Link>
                {task.status === "ready" && <StatusBadge status="ready" />}
              </div>
              {task.source?.passage && (
                <blockquote className="border-l-2 pl-3 text-sm whitespace-pre-wrap text-muted-foreground wrap-anywhere">
                  {task.source.passage}
                </blockquote>
              )}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <PriorityLabel priority={task.priority} />
                {due && <span>Due {due}</span>}
                {task.project && <span>{task.project.title}</span>}
                {task.source && !batch.source && (
                  <Link
                    href={pageHref(task.source.page.id)}
                    className="hover:text-foreground"
                  >
                    Source: {task.source.page.title}
                    {task.source.version ? ` · v${task.source.version}` : ""}
                  </Link>
                )}
                {task.status === "ready" && (
                  <span>Ready for its creator only</span>
                )}
                <AuthoredBy authored={task.title} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <ActionButton
                  size="sm"
                  variant="outline"
                  errorClassName="basis-full"
                  action={() =>
                    taskOperationAction(task.ref, "approve", {
                      expectedVersion: task.version,
                    })
                  }
                >
                  <Check aria-hidden="true" /> Approve
                </ActionButton>
                <Button size="sm" variant="ghost" asChild>
                  <Link href={taskEditHref(task.ref)}>
                    <Pencil aria-hidden="true" /> Edit
                  </Link>
                </Button>
                <RejectButton
                  taskRef={task.ref}
                  version={task.version}
                  extracted={extracted}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
