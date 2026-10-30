"use client";

import {
  Check,
  CircleDashed,
  CircleX,
  ExternalLink,
  Undo2,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { taskOperationAction } from "@/app/(workspace)/actions/tasks";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { TaskView } from "@/lib/tasks/records";
import { pageHref } from "@/lib/workspace/urls";
import { ActionButton, ActionError, useTaskAction } from "./action-state";

const CRITERION_ICON = {
  met: Check,
  partial: CircleDashed,
  not_met: CircleX,
} as const;

function RequestChanges({
  taskRef,
  version,
}: {
  taskRef: string;
  version: number;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const { pending, error, run } = useTaskAction();
  if (!open)
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        <Undo2 aria-hidden="true" /> Request changes
      </Button>
    );
  return (
    <form
      className="basis-full space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!note.trim()) return;
        run(() =>
          taskOperationAction(taskRef, "request_changes", {
            expectedVersion: version,
            note,
          }),
        );
      }}
    >
      <label className="text-sm font-medium" htmlFor={`changes-${taskRef}`}>
        What should change? The next agent reads this in its brief.
      </label>
      <Textarea
        id={`changes-${taskRef}`}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        maxLength={2000}
        required
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending || !note.trim()}>
          {pending && <Spinner aria-hidden="true" />}
          Send back to ready
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
      <ActionError error={error} />
    </form>
  );
}

/** The completion report and the owner's review decision. */
export function ReviewPanel({ task }: { task: TaskView }) {
  const completion = task.completion;
  const report = completion?.value;
  return (
    <div className="space-y-4">
      {report ? (
        <>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              Report by {completion.authoredBy}
            </p>
            <p className="text-sm whitespace-pre-wrap wrap-anywhere">
              {report.summary}
            </p>
          </div>
          {report.criteria.length > 0 && (
            <ul className="space-y-2 text-sm">
              {report.criteria.map((criterion) => {
                const Icon = CRITERION_ICON[criterion.status];
                const text =
                  task.acceptanceCriteria.value[criterion.index] ??
                  `Criterion ${criterion.index + 1}`;
                return (
                  <li key={criterion.index} className="flex gap-2">
                    <Icon
                      size={16}
                      aria-label={criterion.status.replace("_", " ")}
                      className={
                        criterion.status === "met"
                          ? "mt-0.5 shrink-0 text-status-done"
                          : "mt-0.5 shrink-0 text-status-blocked"
                      }
                    />
                    <div className="min-w-0">
                      <p className="wrap-anywhere">{text}</p>
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap wrap-anywhere">
                        {criterion.evidence}
                        {criterion.verification === "self_reported"
                          ? " · self-reported"
                          : " · observed"}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {(report.artifacts.length > 0 ||
            completion.producedLinks.length > 0) && (
            <ul className="flex flex-wrap gap-2 text-xs">
              {completion.producedLinks.map((link) => (
                <li key={link.pageId}>
                  <Link
                    href={pageHref(link.pageId)}
                    className="inline-flex items-center gap-1 rounded-md border px-2 py-1 hover:bg-muted"
                  >
                    {link.slug} · v{link.version}
                    {link.status === "suggested" && " (by another author)"}
                  </Link>
                </li>
              ))}
              {report.artifacts.map((artifact) => (
                <li
                  key={`${artifact.kind}:${artifact.value}`}
                  className="inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 wrap-anywhere"
                >
                  <ExternalLink size={12} aria-hidden="true" />
                  {artifact.kind}: {artifact.value}
                </li>
              ))}
            </ul>
          )}
          {report.remaining && (
            <p className="text-sm text-muted-foreground whitespace-pre-wrap wrap-anywhere">
              Remaining: {report.remaining}
            </p>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          No completion report was recorded.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <ActionButton
          size="sm"
          errorClassName="basis-full"
          action={() =>
            taskOperationAction(task.ref, "review_approve", {
              expectedVersion: task.version,
            })
          }
        >
          <Check aria-hidden="true" /> Approve
        </ActionButton>
        <RequestChanges taskRef={task.ref} version={task.version} />
      </div>
    </div>
  );
}
