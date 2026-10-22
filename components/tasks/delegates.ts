// The "Delegate to…" choices. Plain logic shared by the detail page and the
// edit form, so a delegate that can no longer be offered stays visible.

export interface DelegateAgent {
  id: string;
  label: string;
  labelVerified: boolean;
}

export interface DelegateOption {
  value: string;
  label: string;
  /** The stored delegate, no longer an active agent: nobody can claim the task. */
  unavailable?: boolean;
}

/**
 * Active agents, plus the task's current delegate when it is not among them
 * (an agent disabled after the task was delegated). Without it the select
 * would show "Any suitable agent" for a task only that agent may claim.
 */
export function delegateOptions(
  agents: DelegateAgent[],
  current: { id: string | null; label: string | null },
): DelegateOption[] {
  const options: DelegateOption[] = [
    { value: "", label: "Any suitable agent" },
    ...agents.map((agent) => ({
      value: agent.id,
      label: `${agent.label}${agent.labelVerified ? "" : " (unverified name)"}`,
    })),
  ];
  if (current.id && !agents.some((agent) => agent.id === current.id))
    options.splice(1, 0, {
      value: current.id,
      label: `${current.label ?? "Unknown agent"} (disabled)`,
      unavailable: true,
    });
  return options;
}

/** The warning under a delegate select whose value nobody can act on. */
export function unavailableDelegateNote(
  options: DelegateOption[],
  value: string,
): string | null {
  const option = options.find((item) => item.value === value);
  return option?.unavailable
    ? "This agent is disabled, so no agent can claim the task until you choose another delegate."
    : null;
}
