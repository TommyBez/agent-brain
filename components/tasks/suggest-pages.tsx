"use client";

import { useEffect, useId, useState } from "react";
import { suggestTaskLinksAction } from "@/app/(workspace)/actions/task-link-candidates";
import { addLinkAction } from "@/app/(workspace)/actions/tasks";
import { Button } from "@/components/ui/button";
import { checkedCandidates } from "@/lib/tasks/candidate-selection";
import type {
  PageCandidate,
  TaskLinkSuggestion,
} from "@/lib/tasks/link-candidates";
import type { ProjectCandidate } from "@/lib/tasks/project-candidates";
import {
  suggestionRequest,
  suggestionRequestKey,
} from "@/lib/tasks/suggestion-request";
import { cn } from "@/lib/utils";
import {
  draftChanged,
  type SuggestionDraft,
  suggestionSummary,
} from "./page-suggestions";
import { SuggestionResult } from "./suggestion-result";

type Status = { text: string; error?: boolean };

/**
 * Suggestions are read-only proposals. With `onConfirm` (task forms) the
 * checked pages go back to the form, which links them on Save/Create; without
 * it (task page) confirming links them at once.
 */
export function SuggestPages({
  taskRef,
  draft,
  projectRef,
  onConfirm,
  onProjectConfirm,
}: {
  taskRef?: string;
  /** The form's live text; suggestions use a copy taken on "Suggest pages". */
  draft?: SuggestionDraft;
  projectRef?: string;
  onConfirm?: (candidates: PageCandidate[], projectRef: string | null) => void;
  onProjectConfirm?: (project: { id: string; title: string }) => void;
}) {
  const [run, setRun] = useState(0);
  const [snapshot, setSnapshot] = useState<SuggestionDraft>();
  const [local, setLocal] = useState<{ base?: string; ref: string } | null>(
    null,
  );
  const [status, setStatus] = useState<Status | null>(null);
  const chosenProject = local?.base === projectRef ? local?.ref : projectRef;
  // The snapshot is fixed for a run, so this changes only with the project.
  const key = suggestionRequestKey(
    suggestionRequest(taskRef, snapshot, chosenProject),
  );
  const canSuggest = draft ? Boolean(draft.title.trim()) : Boolean(taskRef);
  const stale = run > 0 && draft && snapshot && draftChanged(snapshot, draft);
  function suggest() {
    if (draft)
      setSnapshot({ title: draft.title, description: draft.description });
    setStatus({ text: "Evaluating suggestions…" });
    setRun((current) => current + 1);
  }
  function useProject(project: ProjectCandidate) {
    if (onProjectConfirm)
      onProjectConfirm({ id: project.projectRef, title: project.title });
    else setLocal({ base: projectRef, ref: project.projectRef });
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={!canSuggest}
          onClick={suggest}
        >
          {stale ? "Suggest again" : "Suggest pages"}
        </Button>
        {draft && !canSuggest && (
          <span className="text-xs text-muted-foreground">
            Add a title to suggest pages.
          </span>
        )}
        {stale && canSuggest && (
          <span className="text-xs text-muted-foreground">
            Text changed — suggest again to update these pages.
          </span>
        )}
      </div>
      <output
        aria-live="polite"
        className={cn(
          "block text-sm",
          status?.error ? "text-destructive" : "text-muted-foreground",
          !status?.text && "sr-only",
        )}
      >
        {status?.text}
      </output>
      {run > 0 && (
        <SuggestionPanel
          key={`${run}:${key}`}
          requestKey={key}
          taskRef={taskRef}
          projectRef={chosenProject ?? null}
          onConfirm={onConfirm}
          onUseProject={useProject}
          onRetry={canSuggest ? suggest : undefined}
          onStatus={setStatus}
          onClose={(message) => {
            setRun(0);
            setStatus(message ? { text: message } : null);
          }}
        />
      )}
    </div>
  );
}

function SuggestionPanel({
  requestKey,
  taskRef,
  projectRef,
  onConfirm,
  onUseProject,
  onRetry,
  onStatus,
  onClose,
}: {
  requestKey: string;
  taskRef?: string;
  projectRef: string | null;
  onConfirm?: (candidates: PageCandidate[], projectRef: string | null) => void;
  onUseProject: (project: ProjectCandidate) => void;
  onRetry?: () => void;
  onStatus: (status: Status | null) => void;
  onClose: (message?: string) => void;
}) {
  const checkboxId = useId();
  const [result, setResult] = useState<TaskLinkSuggestion | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [projectChoice, setProjectChoice] = useState("");
  const [pending, setPending] = useState(true);
  useEffect(() => {
    let active = true;
    onStatus({ text: "Evaluating suggestions…" });
    suggestTaskLinksAction(JSON.parse(requestKey))
      .then((next) => {
        if (!active) return;
        setResult(next);
        if (next.kind === "project")
          setProjectChoice(next.projectProposal.preselectedProjectRef ?? "");
        onStatus({ text: suggestionSummary(next) });
      })
      .catch(() => {
        if (active)
          onStatus({
            text: "Unable to suggest pages. Try again.",
            error: true,
          });
      })
      .finally(() => {
        if (active) setPending(false);
      });
    return () => {
      active = false;
    };
  }, [requestKey, onStatus]);
  async function confirmPages() {
    if (result?.kind !== "pages") return;
    const checked = checkedCandidates(result.candidates, selected);
    const count = `${checked.length} ${checked.length === 1 ? "page" : "pages"}`;
    if (onConfirm) {
      onConfirm(checked, projectRef);
      return onClose(
        checked.length ? `${count} added to this form.` : undefined,
      );
    }
    if (!taskRef) return;
    setPending(true);
    onStatus({ text: `Linking ${count}…` });
    try {
      for (const candidate of checked) {
        const applied = await addLinkAction(
          taskRef,
          candidate.pageRef,
          candidate.role,
        );
        if (!applied.ok) throw new Error(applied.message);
      }
      onClose(checked.length ? `${count} linked.` : undefined);
    } catch (problem) {
      onStatus({
        text:
          problem instanceof Error ? problem.message : "Unable to link pages.",
        error: true,
      });
      setPending(false);
    }
  }
  return (
    <div className="space-y-3 rounded-lg border p-4">
      {result && (
        <SuggestionResult
          result={result}
          idPrefix={checkboxId}
          pending={pending}
          projectChoice={projectChoice}
          onProjectChoice={setProjectChoice}
          onUseProject={onUseProject}
          onRetry={onRetry}
          selected={selected}
          onSelect={(pageRef, checked) =>
            setSelected((current) =>
              checked
                ? [...current, pageRef]
                : current.filter((ref) => ref !== pageRef),
            )
          }
          onConfirmPages={confirmPages}
          confirmLabel={
            onConfirm ? "Add selected pages" : "Link selected pages"
          }
        />
      )}
      <Button
        type="button"
        variant="ghost"
        disabled={pending && !!result}
        onClick={() => onClose()}
      >
        Cancel
      </Button>
    </div>
  );
}
