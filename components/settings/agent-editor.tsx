"use client";

import { Pencil } from "lucide-react";
import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { AgentCreatePolicy, AgentKind } from "@/lib/tasks/types";
import { updateAgentAction } from "@/lib/workspace/settings-actions";

export interface EditableAgent {
  id: string;
  kind: AgentKind;
  label: string;
  capabilities: string[];
  createPolicy: AgentCreatePolicy;
  trustedCreator: boolean;
  claimOnRequest: boolean | null;
  canBeTrustedCreator: boolean;
}

type ClaimChoice = "default" | "allow" | "deny";
const claimChoice = (value: boolean | null): ClaimChoice =>
  value === null ? "default" : value ? "allow" : "deny";

export function AgentEditor({
  agent,
  tasks,
}: {
  agent: EditableAgent;
  /** Task policies are shown only while tasks are enabled. */
  tasks: boolean;
}) {
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const policies = tasks && agent.kind === "agent";

  function save(form: FormData) {
    const claim = form.get("claimOnRequest") as ClaimChoice | null;
    const patch = {
      label: String(form.get("label") ?? ""),
      ...(policies
        ? {
            capabilities: String(form.get("capabilities") ?? "")
              .split(/[\s,]+/)
              .filter(Boolean),
            createPolicy: form.get("createPolicy") as AgentCreatePolicy,
            claimOnRequest:
              claim === "allow" ? true : claim === "deny" ? false : null,
            ...(agent.canBeTrustedCreator
              ? { trustedCreator: form.get("trustedCreator") === "on" }
              : {}),
          }
        : {}),
    };
    setError("");
    startTransition(async () => {
      try {
        const result = await updateAgentAction(agent.id, patch);
        if (result.error) setError(result.error);
        else setOpen(false);
      } catch {
        setError("Unable to save this agent. Try again.");
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setError("");
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Edit ${agent.label}`}
        >
          <Pencil />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit {agent.label}</DialogTitle>
          <DialogDescription>
            Changes apply from the agent’s next request.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            save(new FormData(event.currentTarget));
          }}
        >
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor={`${fieldId}-label`}>Name</FieldLabel>
              <Input
                id={`${fieldId}-label`}
                name="label"
                defaultValue={agent.label}
                maxLength={80}
                required
              />
              <FieldDescription className="text-xs">
                Shown in revision and task history. Saving confirms the name.
              </FieldDescription>
            </Field>
            {policies && (
              <>
                <Field>
                  <FieldLabel htmlFor={`${fieldId}-capabilities`}>
                    Capabilities
                  </FieldLabel>
                  <Textarea
                    id={`${fieldId}-capabilities`}
                    name="capabilities"
                    defaultValue={agent.capabilities.join("\n")}
                    placeholder="e.g. repo:agent-brain"
                    rows={3}
                  />
                  <FieldDescription className="text-xs">
                    One per line. A task that requires a capability can be taken
                    from the queue only by agents that have it.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${fieldId}-policy`}>
                    New tasks
                  </FieldLabel>
                  <NativeSelect
                    id={`${fieldId}-policy`}
                    name="createPolicy"
                    defaultValue={agent.createPolicy}
                  >
                    <NativeSelectOption value="triage">
                      Start in triage until you approve
                    </NativeSelectOption>
                    <NativeSelectOption value="direct">
                      Start ready, for this agent only
                    </NativeSelectOption>
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${fieldId}-claim`}>
                    Can claim on request
                  </FieldLabel>
                  <NativeSelect
                    id={`${fieldId}-claim`}
                    name="claimOnRequest"
                    defaultValue={claimChoice(agent.claimOnRequest)}
                  >
                    <NativeSelectOption value="default">
                      Default: OAuth sessions yes, tokens no
                    </NativeSelectOption>
                    <NativeSelectOption value="allow">Allow</NativeSelectOption>
                    <NativeSelectOption value="deny">
                      Don’t allow
                    </NativeSelectOption>
                  </NativeSelect>
                  <FieldDescription className="text-xs">
                    When you ask in chat, the agent may take that task even if
                    it is unapproved, needs a capability, has a human lead or
                    its project is paused. Never a task assigned to another
                    agent.
                  </FieldDescription>
                </Field>
                {agent.canBeTrustedCreator && (
                  <Field orientation="horizontal">
                    <Checkbox
                      id={`${fieldId}-trusted`}
                      name="trustedCreator"
                      defaultChecked={agent.trustedCreator}
                    />
                    <FieldContent>
                      <FieldLabel htmlFor={`${fieldId}-trusted`}>
                        Trusted creator
                      </FieldLabel>
                      <FieldDescription className="text-xs">
                        Tasks it creates with its own token start approved, so
                        other agents can take them.
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                )}
              </>
            )}
          </FieldGroup>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner aria-hidden="true" />}
              Save agent
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
