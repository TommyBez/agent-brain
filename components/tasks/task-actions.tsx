"use client";

import { ChevronDown, Pencil } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { taskOperationAction } from "@/app/(workspace)/actions/tasks";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { taskEditHref } from "@/lib/workspace/task-urls";
import { ActionError, useTaskAction } from "./action-state";
import { MoveDialog, type MoveInput } from "./move-dialog";
import type { TaskOperation } from "./transitions";

interface ActionTask {
  ref: string;
  status: string;
  approved: boolean;
  version: number;
  /** The claim this screen shows; a newer claim refuses the action. */
  claimCount: number;
  claimed: boolean;
  archived: boolean;
}

type Entry = {
  operation: TaskOperation;
  label: string;
  primary?: boolean;
  destructive?: boolean;
};

/** The owner transitions §6.2 allows from the current status. */
export function ownerOperations(task: ActionTask): Entry[] {
  const open = !["done", "canceled"].includes(task.status);
  const entries: Entry[] = [];
  const add = (entry: Entry) => entries.push(entry);
  if (
    !task.approved &&
    ["triage", "ready", "on_hold", "blocked"].includes(task.status)
  )
    add({ operation: "approve", label: "Approve", primary: true });
  if (task.status === "ready" || task.status === "triage")
    add({ operation: "start", label: "Start (you work on it)" });
  if (
    (task.status === "in_progress" || task.status === "needs_input") &&
    task.claimed
  )
    add({ operation: "release", label: "Release the claim", primary: true });
  if (task.status === "in_progress" && !task.claimed)
    add({ operation: "release", label: "Stop working on it" });
  if (task.status === "blocked")
    add({ operation: "unblock", label: "Unblock", primary: true });
  if (task.status === "on_hold")
    add({ operation: "resume", label: "Resume", primary: true });
  if (["triage", "ready", "in_progress", "needs_input"].includes(task.status))
    add({ operation: "block", label: "Block…" });
  if (open && task.status !== "on_hold")
    add({ operation: "hold", label: "Put on hold" });
  if (open && task.status !== "in_review")
    add({ operation: "close", label: "Mark done" });
  if (open)
    add({
      operation: "cancel",
      label: task.status === "triage" ? "Reject" : "Cancel task",
      destructive: true,
    });
  if (!open) add({ operation: "reopen", label: "Reopen", primary: true });
  return entries;
}

export function TaskActions({ task }: { task: ActionTask }) {
  const { pending, error, run } = useTaskAction();
  const [blocking, setBlocking] = useState(false);
  const entries = ownerOperations(task);
  const primary = entries.filter((entry) => entry.primary);
  const secondary = entries.filter((entry) => !entry.primary);

  function perform(operation: TaskOperation, input: MoveInput = {}) {
    run(() =>
      taskOperationAction(task.ref, operation, {
        expectedVersion: task.version,
        claimCount: task.claimCount,
        ...input,
      }),
    );
  }

  function choose(entry: Entry) {
    if (entry.operation === "block") setBlocking(true);
    else perform(entry.operation);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {primary.map((entry) => (
          <Button
            key={entry.operation}
            type="button"
            disabled={pending}
            onClick={() => choose(entry)}
          >
            {entry.label}
          </Button>
        ))}
        <Button variant="outline" asChild>
          <Link href={taskEditHref(task.ref)}>
            <Pencil size={15} /> Edit
          </Link>
        </Button>
        {secondary.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" disabled={pending}>
                More <ChevronDown aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {secondary.map((entry) => (
                <DropdownMenuItem
                  key={entry.operation}
                  variant={entry.destructive ? "destructive" : "default"}
                  onSelect={() => choose(entry)}
                >
                  {entry.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {pending && <Spinner aria-label="Updating the task" />}
      </div>
      <ActionError error={error} />
      <MoveDialog
        need={blocking ? "reason" : null}
        taskRef={task.ref}
        onCancel={() => setBlocking(false)}
        onConfirm={(input) => {
          setBlocking(false);
          perform("block", input);
        }}
      />
    </div>
  );
}
