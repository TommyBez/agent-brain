"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import type { TaskLinkSuggestion } from "@/lib/tasks/link-candidates";
import type { ProjectCandidate } from "@/lib/tasks/project-candidates";
import {
  emptyProjectMessage,
  projectTimedOut,
  unevaluatedPagesNote,
  unreachableKind,
} from "./page-suggestions";

type ProjectPhase = Extract<TaskLinkSuggestion, { kind: "project" }>;
type PagesPhase = Extract<TaskLinkSuggestion, { kind: "pages" }>;

export interface SuggestionResultProps {
  result: TaskLinkSuggestion;
  idPrefix: string;
  pending: boolean;
  projectChoice: string;
  onProjectChoice: (projectRef: string) => void;
  onUseProject: (project: ProjectCandidate) => void;
  /** Runs Suggest pages again; absent when the draft cannot be suggested. */
  onRetry?: () => void;
  selected: readonly string[];
  onSelect: (pageRef: string, checked: boolean) => void;
  onConfirmPages: () => void;
  confirmLabel: string;
}

/**
 * Renders one suggestion phase. The server decides the phase: a task without
 * a project always gets the project chooser, even when it has no candidates.
 */
export function SuggestionResult(props: SuggestionResultProps) {
  const { result } = props;
  switch (result.kind) {
    case "project":
      return <ProjectChooser {...props} result={result} />;
    case "pages":
      return <PageChoices {...props} result={result} />;
    default:
      return unreachableKind(result);
  }
}

function ProjectChooser({
  result,
  idPrefix,
  pending,
  projectChoice,
  onProjectChoice,
  onUseProject,
  onRetry,
}: SuggestionResultProps & { result: ProjectPhase }) {
  const proposal = result.projectProposal;
  const empty = proposal.candidates.length === 0;
  return (
    <fieldset className="space-y-3" data-phase="project">
      <legend className="text-sm font-medium">
        Choose a project before suggesting pages
      </legend>
      {empty ? (
        <>
          <p className="text-sm text-muted-foreground">
            {emptyProjectMessage(result)}
          </p>
          {projectTimedOut(result) && onRetry && (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onRetry}
            >
              Suggest again
            </Button>
          )}
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            This is a proposal. Confirm a project to evaluate its decisions and
            context pages.{" "}
            {proposal.status === "deterministic"
              ? "Ranked without evaluation because it was unavailable."
              : "A preselection still needs your confirmation."}
          </p>
          <label htmlFor={`${idPrefix}-project`} className="block text-sm">
            Project proposal
          </label>
          <NativeSelect
            id={`${idPrefix}-project`}
            value={projectChoice}
            onChange={(event) => onProjectChoice(event.target.value)}
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
        </>
      )}
    </fieldset>
  );
}

function PageChoices({
  result,
  idPrefix,
  pending,
  selected,
  onSelect,
  onConfirmPages,
  confirmLabel,
}: SuggestionResultProps & { result: PagesPhase }) {
  const note = unevaluatedPagesNote(result);
  return (
    <>
      <fieldset className="space-y-3" disabled={pending} data-phase="pages">
        <legend className="text-sm font-medium">Suggested pages</legend>
        {result.candidates.length === 0 && (
          <p className="text-sm text-muted-foreground">No matching pages.</p>
        )}
        {result.candidates.map((candidate) => (
          <label
            htmlFor={`${idPrefix}-${candidate.pageRef}`}
            key={candidate.pageRef}
            className="flex items-start gap-3 text-sm"
          >
            <Checkbox
              id={`${idPrefix}-${candidate.pageRef}`}
              checked={selected.includes(candidate.pageRef)}
              disabled={pending}
              onCheckedChange={(checked) =>
                onSelect(candidate.pageRef, checked === true)
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
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </fieldset>
      {result.candidates.length > 0 && (
        <Button
          type="button"
          disabled={pending || !selected.length}
          onClick={onConfirmPages}
        >
          {confirmLabel}
        </Button>
      )}
    </>
  );
}
