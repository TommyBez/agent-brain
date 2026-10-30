"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  TASK_BLOCKED_REASONS,
  type TaskBlockedReason,
} from "@/lib/tasks/types";
import { BLOCKED_REASON_LABELS } from "./labels";

export type MoveInput = { reason?: TaskBlockedReason; note?: string };

/** Asks for what a move needs: why it is blocked, or which changes to make. */
export function MoveDialog({
  need,
  taskRef,
  onConfirm,
  onCancel,
}: {
  need: "reason" | "note" | null;
  taskRef: string;
  onConfirm: (input: MoveInput) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState<TaskBlockedReason>("external");
  const [note, setNote] = useState("");
  return (
    <Dialog open={need !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (need === "note" && !note.trim()) return;
            onConfirm(
              need === "reason"
                ? { reason, ...(note.trim() ? { note } : {}) }
                : { note },
            );
            setNote("");
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {need === "reason"
                ? `Why is ${taskRef} blocked?`
                : `What should change in ${taskRef}?`}
            </DialogTitle>
            <DialogDescription>
              {need === "reason"
                ? "Blocking ends any claim. The task waits until you unblock it."
                : "The task goes back to ready; the next agent reads your note in its brief."}
            </DialogDescription>
          </DialogHeader>
          {need === "reason" && (
            <div className="space-y-2">
              <Label htmlFor={`${id}-reason`}>Reason</Label>
              <NativeSelect
                id={`${id}-reason`}
                value={reason}
                onChange={(event) =>
                  setReason(event.target.value as TaskBlockedReason)
                }
              >
                {TASK_BLOCKED_REASONS.map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {BLOCKED_REASON_LABELS[value]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor={`${id}-note`}>
              {need === "reason" ? "Note (optional)" : "Requested changes"}
            </Label>
            <Textarea
              id={`${id}-note`}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={2000}
              required={need === "note"}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={need === "note" && !note.trim()}>
              {need === "reason" ? "Block" : "Send back"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
