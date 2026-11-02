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

type Draft = { title: string; description: string; projectRef?: string };

export function SuggestPages({
  taskRef,
  draft,
  projectRef,
  onConfirm,
  onProjectConfirm,
}: {
  taskRef?: string;
  draft?: Draft;
  projectRef?: string;
  onConfirm?: (candidates: PageCandidate[]) => void;
  onProjectConfirm?: (project: { id: string; title: string }) => void;
}) {
  const [run, setRun] = useState(0);
  const [local, setLocal] = useState<{ base?: string; ref: string } | null>(
    null,
  );
  const externalProject = draft?.projectRef ?? projectRef;
  const chosenProject =
    local?.base === externalProject ? local?.ref : externalProject;
  const key = suggestionRequestKey(
    suggestionRequest(taskRef, draft, chosenProject),
  );
  function useProject(project: ProjectCandidate) {
    if (onProjectConfirm)
      onProjectConfirm({ id: project.projectRef, title: project.title });
    else setLocal({ base: externalProject, ref: project.projectRef });
  }
  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant="outline"
        disabled={!taskRef && !draft?.title.trim()}
        onClick={() => setRun((current) => current + 1)}
      >
        Suggest pages
      </Button>
      {run > 0 && (
        <SuggestionPanel
          key={`${run}:${key}`}
          requestKey={key}
          taskRef={taskRef}
          onConfirm={onConfirm}
          onUseProject={useProject}
          onClose={() => setRun(0)}
        />
      )}
    </div>
  );
}

function SuggestionPanel({
  requestKey,
  taskRef,
  onConfirm,
  onUseProject,
  onClose,
}: {
  requestKey: string;
  taskRef?: string;
  onConfirm?: (candidates: PageCandidate[]) => void;
  onUseProject: (project: ProjectCandidate) => void;
  onClose: () => void;
}) {
  const checkboxId = useId();
  const [result, setResult] = useState<TaskLinkSuggestion | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [projectChoice, setProjectChoice] = useState("");
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    suggestTaskLinksAction(JSON.parse(requestKey))
      .then((next) => {
        if (!active) return;
        setResult(next);
        setProjectChoice(next.projectProposal?.preselectedProjectRef ?? "");
      })
      .catch(() => {
        if (active) setError("Unable to suggest pages. Try again.");
      })
      .finally(() => {
        if (active) setPending(false);
      });
    return () => {
      active = false;
    };
  }, [requestKey]);
  async function confirmPages() {
    setPending(true);
    setError("");
    try {
      const checked = checkedCandidates(result?.candidates ?? [], selected);
      if (onConfirm) onConfirm(checked);
      else if (taskRef)
        for (const candidate of checked) {
          const applied = await addLinkAction(
            taskRef,
            candidate.pageRef,
            candidate.role,
          );
          if (!applied.ok) throw new Error(applied.message);
        }
      onClose();
    } catch (problem) {
      setError(
        problem instanceof Error ? problem.message : "Unable to link pages.",
      );
    } finally {
      setPending(false);
    }
  }
  const proposal = result?.projectProposal;
  return (
    <div className="space-y-3 rounded-lg border p-4">
      {pending && (
        <output className="block text-sm text-muted-foreground">
          Evaluating suggestions…
        </output>
      )}
      {proposal && (
        <div className="space-y-3">
          <p className="text-sm font-medium">
            Choose a project before suggesting pages
          </p>
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
        </div>
      )}
      {result && !proposal && (
        <>
          {result.candidates.length === 0 && (
            <p className="text-sm text-muted-foreground">No matching pages.</p>
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
          <Button type="button" disabled={pending} onClick={confirmPages}>
            Confirm selected pages
          </Button>
        </>
      )}
      <Button
        type="button"
        variant="ghost"
        disabled={pending && !!result}
        onClick={onClose}
      >
        Cancel
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
