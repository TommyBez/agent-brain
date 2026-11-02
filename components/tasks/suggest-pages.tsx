"use client";

import { useEffect, useId, useState } from "react";
import { suggestTaskLinksAction } from "@/app/(workspace)/actions/task-link-candidates";
import { addLinkAction } from "@/app/(workspace)/actions/tasks";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
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
  onStatus,
  onClose,
}: {
  requestKey: string;
  taskRef?: string;
  projectRef: string | null;
  onConfirm?: (candidates: PageCandidate[], projectRef: string | null) => void;
  onUseProject: (project: ProjectCandidate) => void;
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
        setProjectChoice(next.projectProposal?.preselectedProjectRef ?? "");
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
    const checked = checkedCandidates(result?.candidates ?? [], selected);
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
  const proposal = result?.projectProposal;
  return (
    <div className="space-y-3 rounded-lg border p-4">
      {proposal && (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">
            Choose a project before suggesting pages
          </legend>
          <p className="text-xs text-muted-foreground">
            This is a proposal. Confirm a project to evaluate its decisions and
            context pages.{" "}
            {proposal.status === "deterministic"
              ? "Showing deterministic candidates because JEV was unavailable or no candidates were found."
              : "A preselection still needs your confirmation."}
          </p>
          <label htmlFor={`${checkboxId}-project`} className="block text-sm">
            Project proposal
          </label>
          <NativeSelect
            id={`${checkboxId}-project`}
            value={projectChoice}
            onChange={(event) => setProjectChoice(event.target.value)}
          >
            <NativeSelectOption value="">Choose a project…</NativeSelectOption>
            {proposal.candidates.map((project) => (
              <NativeSelectOption
                key={project.projectRef}
                value={project.projectRef}
              >
                {project.title} · {project.slug}
                {project.score === null ? "" : ` · ${project.score.toFixed(2)}`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <ul className="max-h-56 space-y-2 overflow-y-auto text-xs text-muted-foreground">
            {proposal.candidates.map((project) => (
              <li key={project.projectRef}>
                {project.title} · {project.slug} · {project.reason}
                {project.score === null ? "" : ` · ${project.score.toFixed(2)}`}
              </li>
            ))}
          </ul>
          <Button
            type="button"
            disabled={pending || !projectChoice}
            onClick={() => {
              const project = proposal.candidates.find(
                (project) => project.projectRef === projectChoice,
              );
              if (project) onUseProject(project);
            }}
          >
            Confirm project for suggestions
          </Button>
        </fieldset>
      )}
      {result && !proposal && (
        <>
          <fieldset className="space-y-3" disabled={pending}>
            <legend className="text-sm font-medium">Suggested pages</legend>
            {result.candidates.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No matching pages.
              </p>
            )}
            {result.candidates.map((candidate) => (
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
          </fieldset>
          {result.candidates.length > 0 && (
            <Button
              type="button"
              disabled={pending || !selected.length}
              onClick={confirmPages}
            >
              {onConfirm ? "Add selected pages" : "Link selected pages"}
            </Button>
          )}
        </>
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
