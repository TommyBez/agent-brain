"use client";

import { Plus } from "lucide-react";
import { useId, useState } from "react";
import {
  addLinkAction,
  addPartyAction,
  delegateTaskAction,
  dependencyAction,
} from "@/app/(workspace)/actions/tasks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import {
  type ConnectionChoice,
  type ConnectionChoices,
  ConnectionPicker,
} from "@/components/workspace/connection-picker";
import {
  parseTaskRef,
  TASK_PARTY_ROLES,
  type TaskPartyRole,
} from "@/lib/tasks/types";
import { ActionError, useTaskAction } from "./action-state";
import { delegateOptions, unavailableDelegateNote } from "./delegates";

type Agent = { id: string; label: string; labelVerified: boolean };

/** "Delegate to…": only the chosen agent may claim it. */
export function DelegateSelect({
  taskRef,
  version,
  delegateId,
  delegateLabel,
  agents,
}: {
  taskRef: string;
  version: number;
  delegateId: string | null;
  delegateLabel: string | null;
  agents: Agent[];
}) {
  const id = useId();
  const { pending, error, run } = useTaskAction();
  const options = delegateOptions(agents, {
    id: delegateId,
    label: delegateLabel,
  });
  const note = unavailableDelegateNote(options, delegateId ?? "");
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="sr-only">
        Delegate to
      </Label>
      <div className="flex items-center gap-2">
        <NativeSelect
          id={id}
          size="sm"
          value={delegateId ?? ""}
          disabled={pending}
          onChange={(event) =>
            run(() =>
              delegateTaskAction(taskRef, version, event.target.value || null),
            )
          }
        >
          {options.map((option) => (
            <NativeSelectOption key={option.value} value={option.value}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {pending && <Spinner aria-label="Saving the delegate" />}
      </div>
      {note && <p className="text-xs text-destructive">{note}</p>}
      <ActionError error={error} />
    </div>
  );
}

const ROLE_LABELS: Record<TaskPartyRole, string> = {
  lead: "Lead",
  support: "Support",
  reviewer: "Reviewer",
  requester: "Requester",
};

/** Participant picker: a person page, a group, an agent or you. */
export function PartyForm({
  taskRef,
  agents,
  people,
}: {
  taskRef: string;
  agents: Agent[];
  people: ConnectionChoices;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<TaskPartyRole>("support");
  const [kind, setKind] = useState<"person" | "group" | "agent" | "owner">(
    "person",
  );
  const [person, setPerson] = useState<ConnectionChoice | null>(null);
  const [group, setGroup] = useState("");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [sourceNote, setSourceNote] = useState("");
  const { pending, error, run } = useTaskAction();
  if (!open)
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="px-0"
        onClick={() => setOpen(true)}
      >
        <Plus aria-hidden="true" /> Add participant
      </Button>
    );
  const ready =
    kind === "owner" ||
    (kind === "person" && person) ||
    (kind === "group" && group.trim()) ||
    (kind === "agent" && agentId);
  return (
    <form
      className="space-y-3 rounded-lg border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        const party = {
          role,
          kind,
          ...(kind === "person" && person ? { personPageRef: person.id } : {}),
          ...(kind === "group" ? { groupLabel: group.trim() } : {}),
          ...(kind === "agent" ? { agentId } : {}),
          ...(sourceNote.trim() ? { sourceNote: sourceNote.trim() } : {}),
        };
        run(
          () => addPartyAction(taskRef, party),
          () => {
            setOpen(false);
            setPerson(null);
            setGroup("");
            setSourceNote("");
          },
        );
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-role`} className="text-xs">
            Role
          </Label>
          <NativeSelect
            id={`${id}-role`}
            size="sm"
            value={role}
            onChange={(event) => setRole(event.target.value as TaskPartyRole)}
          >
            {TASK_PARTY_ROLES.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {ROLE_LABELS[value]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-kind`} className="text-xs">
            Who
          </Label>
          <NativeSelect
            id={`${id}-kind`}
            size="sm"
            value={kind}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            <NativeSelectOption value="person">A person</NativeSelectOption>
            <NativeSelectOption value="group">A group</NativeSelectOption>
            {agents.length > 0 && (
              <NativeSelectOption value="agent">An agent</NativeSelectOption>
            )}
            <NativeSelectOption value="owner">You</NativeSelectOption>
          </NativeSelect>
        </div>
      </div>
      {kind === "person" && (
        <ConnectionPicker
          type="person"
          initialChoices={people}
          value={person}
          onChange={setPerson}
        />
      )}
      {kind === "group" && (
        <Input
          aria-label="Group name"
          value={group}
          onChange={(event) => setGroup(event.target.value)}
          maxLength={120}
          placeholder="e.g. Team JSB"
        />
      )}
      {kind === "agent" && (
        <NativeSelect
          aria-label="Agent"
          size="sm"
          value={agentId}
          onChange={(event) => setAgentId(event.target.value)}
        >
          {agents.map((agent) => (
            <NativeSelectOption key={agent.id} value={agent.id}>
              {agent.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}
      <Input
        aria-label="Where this comes from (optional)"
        value={sourceNote}
        onChange={(event) => setSourceNote(event.target.value)}
        maxLength={300}
        placeholder="Source, e.g. minutes 15/10 (optional)"
      />
      {role === "lead" && (kind === "person" || kind === "group") && (
        <p className="text-xs text-muted-foreground">
          A person or group lead keeps the task out of the agents' queue; an
          agent may still take it when you ask it to.
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending || !ready}>
          {pending && <Spinner aria-hidden="true" />}
          Add
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

/** "This task waits for T-n": the queue holds it until that one is done. */
export function DependencyForm({ taskRef }: { taskRef: string }) {
  const id = useId();
  const [value, setValue] = useState("");
  const { pending, error, run } = useTaskAction();
  const valid = parseTaskRef(value.trim())?.kind === "number";
  return (
    <form
      className="space-y-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        run(
          () => dependencyAction(taskRef, value.trim(), true),
          () => setValue(""),
        );
      }}
    >
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        Waits for
      </Label>
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="T-12"
          className="h-8"
          maxLength={20}
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={!valid || pending}
        >
          {pending && <Spinner aria-hidden="true" />}
          Add
        </Button>
      </div>
      <ActionError error={error} />
    </form>
  );
}

const LINK_ROLES = [
  ["context", "Context"],
  ["decision", "Decision"],
  ["stakeholder", "Stakeholder"],
  ["source", "Source"],
] as const;

/** Link a page as knowledge for the task (active, by you). */
export function LinkForm({
  taskRef,
  pages,
}: {
  taskRef: string;
  pages: ConnectionChoices;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<ConnectionChoice | null>(null);
  const [role, setRole] = useState<(typeof LINK_ROLES)[number][0]>("context");
  const { pending, error, run } = useTaskAction();
  if (!open)
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        <Plus aria-hidden="true" /> Link a page
      </Button>
    );
  return (
    <form
      className="space-y-3 rounded-lg border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!page) return;
        run(
          () => addLinkAction(taskRef, page.id, role),
          () => {
            setOpen(false);
            setPage(null);
          },
        );
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <ConnectionPicker
          initialChoices={pages}
          value={page}
          onChange={setPage}
        />
        <div>
          <Label htmlFor={`${id}-role`} className="sr-only">
            Role
          </Label>
          <NativeSelect
            id={`${id}-role`}
            value={role}
            onChange={(event) =>
              setRole(event.target.value as (typeof LINK_ROLES)[number][0])
            }
          >
            {LINK_ROLES.map(([value, label]) => (
              <NativeSelectOption key={value} value={value}>
                {label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!page || pending}>
          {pending && <Spinner aria-hidden="true" />}
          Link
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
