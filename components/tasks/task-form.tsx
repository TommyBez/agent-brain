"use client";

import Link from "next/link";
import { useId, useState } from "react";
import {
  createTaskAction,
  updateTaskAction,
} from "@/app/(workspace)/actions/tasks";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  type ConnectionChoice,
  type ConnectionChoices,
  ConnectionPicker,
} from "@/components/workspace/connection-picker";
import {
  OWNER_REVIEWED_OUTPUTS,
  TASK_DUE_KINDS,
  TASK_EXPECTED_OUTPUTS,
  TASK_LIMITS,
  type TaskDueKind,
  type TaskExpectedOutput,
} from "@/lib/tasks/types";
import type { TaskFormChoices } from "@/lib/workspace/task-queries";
import { taskHref } from "@/lib/workspace/task-urls";
import { ActionError, useTaskAction } from "./action-state";
import { delegateOptions, unavailableDelegateNote } from "./delegates";
import { dueInput, initialDue } from "./due";
import {
  DUE_KIND_LABELS,
  EXPECTED_OUTPUT_LABELS,
  PRIORITY_LABELS,
} from "./labels";

export interface TaskFormValues {
  ref: string;
  version: number;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  due: {
    kind: string;
    on: string | null;
    at: string | null;
    text: string | null;
  };
  project: ConnectionChoice | null;
  expectedOutput: string;
  reviewPolicy: string;
  requiresHuman: boolean;
  requiredCapability: string | null;
  delegateId: string | null;
  delegateLabel: string | null;
}

const lines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const sameDue = (a: Record<string, string>, b: Record<string, string>) =>
  JSON.stringify(Object.entries(a).sort()) ===
  JSON.stringify(Object.entries(b).sort());

/** Create or edit a task as the owner; edits send only the changed fields. */
export function TaskForm({
  task,
  choices,
  projectChoices,
  initialProject = null,
}: {
  task?: TaskFormValues;
  choices: TaskFormChoices;
  projectChoices: ConnectionChoices;
  initialProject?: ConnectionChoice | null;
}) {
  const id = useId();
  const [idempotencyKey] = useState(() => `ui-${crypto.randomUUID()}`);
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [criteria, setCriteria] = useState(
    task?.acceptanceCriteria.join("\n") ?? "",
  );
  const [priority, setPriority] = useState(task?.priority ?? 2);
  const [due, setDue] = useState(() => initialDue(task?.due));
  const [project, setProject] = useState<ConnectionChoice | null>(
    task?.project ?? initialProject,
  );
  const [expectedOutput, setExpectedOutput] = useState(
    task?.expectedOutput ?? "none",
  );
  const [reviewPolicy, setReviewPolicy] = useState(
    task?.reviewPolicy ?? "auto",
  );
  const [requiresHuman, setRequiresHuman] = useState(
    task?.requiresHuman ?? false,
  );
  const [capability, setCapability] = useState(task?.requiredCapability ?? "");
  const [delegateId, setDelegateId] = useState(task?.delegateId ?? "");
  const [problem, setProblem] = useState("");
  const { pending, error, run } = useTaskAction();
  const ownerReviewed = (OWNER_REVIEWED_OUTPUTS as readonly string[]).includes(
    expectedOutput,
  );
  const policy = ownerReviewed ? "owner" : reviewPolicy;
  const criteriaLines = lines(criteria);
  const knownCapability =
    !capability || choices.capabilities.includes(capability);
  const delegates = delegateOptions(choices.agents, {
    id: task?.delegateId ?? null,
    label: task?.delegateLabel ?? null,
  });
  const delegateNote = unavailableDelegateNote(delegates, delegateId);

  function submit() {
    setProblem("");
    if (!title.trim()) return setProblem("Give the task a title.");
    if (criteriaLines.length > TASK_LIMITS.acceptanceCriteria)
      return setProblem(
        `At most ${TASK_LIMITS.acceptanceCriteria} acceptance criteria.`,
      );
    const dueValue = dueInput(due);
    if ("error" in dueValue) return setProblem(dueValue.error);
    if (!task) {
      const input = {
        title: title.trim(),
        ...(description.trim() ? { description } : {}),
        ...(criteriaLines.length ? { acceptanceCriteria: criteriaLines } : {}),
        priority,
        ...(dueValue.due.kind !== "unset" ? { due: dueValue.due } : {}),
        ...(project ? { projectRef: project.id } : {}),
        expectedOutput,
        reviewPolicy: policy,
        ...(requiresHuman ? { requiresHuman } : {}),
        ...(capability ? { requiredCapability: capability } : {}),
        ...(delegateId ? { delegateAgentId: delegateId } : {}),
        idempotencyKey,
      };
      return run(() => createTaskAction(input));
    }
    const patch: Record<string, unknown> = {};
    if (title.trim() !== task.title) patch.title = title.trim();
    if (description !== task.description) patch.description = description;
    if (criteriaLines.join("\n") !== task.acceptanceCriteria.join("\n"))
      patch.acceptanceCriteria = criteriaLines;
    if (priority !== task.priority) patch.priority = priority;
    const before = dueInput(initialDue(task.due));
    if (!("due" in before) || !sameDue(before.due, dueValue.due))
      patch.due = dueValue.due;
    if ((project?.id ?? null) !== (task.project?.id ?? null))
      patch.projectRef = project?.id ?? null;
    if (expectedOutput !== task.expectedOutput)
      patch.expectedOutput = expectedOutput;
    if (policy !== task.reviewPolicy) patch.reviewPolicy = policy;
    if (requiresHuman !== task.requiresHuman)
      patch.requiresHuman = requiresHuman;
    if ((capability || null) !== task.requiredCapability)
      patch.requiredCapability = capability || null;
    const delegate =
      (delegateId || null) !== task.delegateId
        ? { agentId: delegateId || null }
        : undefined;
    if (!Object.keys(patch).length && !delegate)
      return setProblem("Nothing changed.");
    run(() => updateTaskAction(task.ref, task.version, patch, delegate));
  }

  const field = "space-y-2";
  return (
    <form
      className="max-w-3xl space-y-8"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className={field}>
        <Label htmlFor={`${id}-title`}>Title</Label>
        <Input
          id={`${id}-title`}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={TASK_LIMITS.title}
          required
          className="text-base"
        />
      </div>
      <div className="grid gap-6 sm:grid-cols-2">
        <div className={field}>
          <Label htmlFor={`${id}-project`}>Project</Label>
          <div className="flex gap-2">
            <ConnectionPicker
              id={`${id}-project`}
              type="project"
              initialChoices={projectChoices}
              value={project}
              onChange={setProject}
            />
            {project && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setProject(null)}
              >
                Clear
              </Button>
            )}
          </div>
        </div>
        <div className={field}>
          <Label htmlFor={`${id}-priority`}>Priority</Label>
          <NativeSelect
            id={`${id}-priority`}
            value={priority}
            onChange={(event) => setPriority(Number(event.target.value))}
          >
            {PRIORITY_LABELS.map((label, value) => (
              <NativeSelectOption key={label} value={value}>
                {label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>
      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-medium">Due</legend>
        <div className="grid gap-4 sm:grid-cols-[14rem_minmax(0,1fr)]">
          <NativeSelect
            aria-label="Kind of due date"
            value={due.kind}
            onChange={(event) =>
              setDue({ ...due, kind: event.target.value as TaskDueKind })
            }
          >
            {TASK_DUE_KINDS.map((kind) => (
              <NativeSelectOption key={kind} value={kind}>
                {DUE_KIND_LABELS[kind]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {due.kind !== "unset" && (
            <div className="flex flex-wrap gap-2">
              <Input
                type="date"
                aria-label={
                  due.kind === "approximate" || due.kind === "event"
                    ? "Estimated date (optional)"
                    : "Date"
                }
                value={due.date}
                onChange={(event) =>
                  setDue({ ...due, date: event.target.value })
                }
                className="w-44"
              />
              {(due.kind === "datetime" || due.kind === "hard") && (
                <Input
                  type="time"
                  aria-label={due.kind === "hard" ? "Time (optional)" : "Time"}
                  value={due.time}
                  onChange={(event) =>
                    setDue({ ...due, time: event.target.value })
                  }
                  className="w-32"
                />
              )}
            </div>
          )}
        </div>
        {due.kind !== "unset" && (
          <div className={field}>
            <Label htmlFor={`${id}-due-text`}>
              {due.kind === "approximate" || due.kind === "event"
                ? "Original wording"
                : "Original wording (optional)"}
            </Label>
            <Input
              id={`${id}-due-text`}
              value={due.text}
              onChange={(event) => setDue({ ...due, text: event.target.value })}
              maxLength={TASK_LIMITS.dueText}
              placeholder={
                due.kind === "event"
                  ? "next steering meeting"
                  : "end of October"
              }
            />
            <p className="text-xs text-muted-foreground">
              Times are in Europe/Rome. Approximate and event deadlines keep
              their wording and show apart in the calendar.
            </p>
          </div>
        )}
      </fieldset>
      <div className={field}>
        <Label htmlFor={`${id}-criteria`}>Acceptance criteria</Label>
        <Textarea
          id={`${id}-criteria`}
          value={criteria}
          onChange={(event) => setCriteria(event.target.value)}
          rows={4}
          placeholder={
            "One per line\nThe recommendation is in the project page"
          }
        />
        <p className="text-xs text-muted-foreground tabular-nums">
          {criteriaLines.length} of {TASK_LIMITS.acceptanceCriteria}, one per
          line
        </p>
      </div>
      <div className={field}>
        <Label htmlFor={`${id}-description`}>Description</Label>
        <Textarea
          id={`${id}-description`}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={8}
          maxLength={TASK_LIMITS.description}
          placeholder="Markdown. Mention pages as /pages/<slug> to link them as context."
        />
      </div>
      <div className="grid gap-6 sm:grid-cols-2">
        <div className={field}>
          <Label htmlFor={`${id}-output`}>Expected output</Label>
          <NativeSelect
            id={`${id}-output`}
            value={expectedOutput}
            onChange={(event) =>
              setExpectedOutput(event.target.value as TaskExpectedOutput)
            }
          >
            {TASK_EXPECTED_OUTPUTS.map((output) => (
              <NativeSelectOption key={output} value={output}>
                {EXPECTED_OUTPUT_LABELS[output]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className={field}>
          <Label htmlFor={`${id}-review`}>Who closes it</Label>
          <NativeSelect
            id={`${id}-review`}
            value={policy}
            disabled={ownerReviewed}
            onChange={(event) => setReviewPolicy(event.target.value)}
          >
            <NativeSelectOption value="auto">
              The agent, when the work is done
            </NativeSelectOption>
            <NativeSelectOption value="owner">
              You, after reviewing it
            </NativeSelectOption>
          </NativeSelect>
          {ownerReviewed && (
            <p className="text-xs text-muted-foreground">
              Decisions and outside actions are always reviewed by you.
            </p>
          )}
        </div>
        <div className={field}>
          <Label htmlFor={`${id}-delegate`}>Delegate to</Label>
          <NativeSelect
            id={`${id}-delegate`}
            value={delegateId}
            onChange={(event) => setDelegateId(event.target.value)}
          >
            {delegates.map((option) => (
              <NativeSelectOption key={option.value} value={option.value}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {delegateNote ? (
            <p className="text-xs text-destructive">{delegateNote}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Only the delegate can claim it; you stay responsible.
            </p>
          )}
        </div>
        <div className={field}>
          <Label htmlFor={`${id}-capability`}>Required capability</Label>
          <NativeSelect
            id={`${id}-capability`}
            value={capability}
            onChange={(event) => setCapability(event.target.value)}
            disabled={!choices.capabilities.length && !capability}
          >
            <NativeSelectOption value="">None</NativeSelectOption>
            {!knownCapability && (
              <NativeSelectOption value={capability}>
                {capability} (no agent has it)
              </NativeSelectOption>
            )}
            {choices.capabilities.map((item) => (
              <NativeSelectOption key={item} value={item}>
                {item}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">
            Capabilities come from the agents in{" "}
            <Link href="/agents" className="underline underline-offset-4">
              Agents &amp; access
            </Link>
            .
          </p>
        </div>
      </div>
      <div className="flex items-start gap-3">
        <Checkbox
          id={`${id}-human`}
          checked={requiresHuman}
          onCheckedChange={(checked) => setRequiresHuman(checked === true)}
        />
        <div className="space-y-1">
          <Label htmlFor={`${id}-human`}>Only a person can do this</Label>
          <p className="text-xs text-muted-foreground">
            Agents never claim it, not even on request (for example a sign-in or
            a console step).
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t pt-6">
        <Button type="submit" disabled={pending}>
          {pending && <Spinner aria-hidden="true" />}
          {task ? "Save task" : "Create task"}
        </Button>
        <Button type="button" variant="ghost" asChild>
          <Link href={task ? taskHref(task.ref) : "/tasks"}>Cancel</Link>
        </Button>
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        <ActionError error={error} className="basis-full" />
      </div>
    </form>
  );
}
