"use client";

import { useId, useState } from "react";
import { suggestTaskLinksAction } from "@/app/(workspace)/actions/task-link-candidates";
import { addLinkAction } from "@/app/(workspace)/actions/tasks";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { checkedCandidates } from "@/lib/tasks/candidate-selection";
import type { PageCandidate } from "@/lib/tasks/link-candidates";

export function SuggestPages({
  taskRef,
  draft,
  onConfirm,
}: {
  taskRef?: string;
  draft?: { title: string; description: string; projectRef?: string };
  onConfirm?: (candidates: PageCandidate[]) => void;
}) {
  const checkboxId = useId();
  const [candidates, setCandidates] = useState<PageCandidate[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function suggest() {
    setPending(true);
    setError("");
    setSelected([]);
    setCandidates(null);
    try {
      const result = await suggestTaskLinksAction(
        taskRef ? { ref: taskRef } : draft,
      );
      setCandidates(result.candidates);
    } catch {
      setError("Unable to suggest pages. Try again.");
    } finally {
      setPending(false);
    }
  }
  async function confirm() {
    setPending(true);
    setError("");
    try {
      const checked = checkedCandidates(candidates ?? [], selected);
      if (onConfirm) onConfirm(checked);
      else if (taskRef)
        for (const candidate of checked) {
          const result = await addLinkAction(
            taskRef,
            candidate.pageRef,
            candidate.role,
          );
          if (!result.ok) throw new Error(result.message);
        }
      setCandidates(null);
      setSelected([]);
    } catch (problem) {
      setError(
        problem instanceof Error ? problem.message : "Unable to link pages.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant="outline"
        disabled={pending || (!taskRef && !draft?.title.trim())}
        onClick={suggest}
      >
        Suggest pages
      </Button>
      {candidates && (
        <div className="space-y-3 rounded-lg border p-4">
          {candidates.length === 0 && (
            <p className="text-sm text-muted-foreground">No matching pages.</p>
          )}
          {candidates.map((candidate) => (
            <label
              htmlFor={`${checkboxId}-${candidate.pageRef}`}
              key={candidate.pageRef}
              className="flex items-start gap-3 text-sm"
            >
              <Checkbox
                id={`${checkboxId}-${candidate.pageRef}`}
                checked={selected.includes(candidate.pageRef)}
                disabled={pending}
                onCheckedChange={(checked) =>
                  setSelected((current) =>
                    checked
                      ? [...current, candidate.pageRef]
                      : current.filter((ref) => ref !== candidate.pageRef),
                  )
                }
              />
              <span>
                <span className="font-medium">{candidate.title}</span>
                <span className="block text-muted-foreground">
                  {candidate.slug} · {candidate.role}
                </span>
                <span className="block">{candidate.reason}</span>
              </span>
            </label>
          ))}
          <div className="flex gap-2">
            <Button type="button" disabled={pending} onClick={confirm}>
              Confirm selected
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setCandidates(null);
                setSelected([]);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
