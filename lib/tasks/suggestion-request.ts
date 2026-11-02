/** Project choice scopes reads only; callers persist a form's project through its normal Save. */
export function suggestionRequest(
  taskRef: string | undefined,
  draft:
    | { title: string; description: string; projectRef?: string }
    | undefined,
  projectRef?: string,
) {
  return draft
    ? { ...draft, ...(projectRef ? { projectRef } : {}) }
    : { ref: taskRef, ...(projectRef ? { projectRef } : {}) };
}

/** A changed project invalidates the previous panel, checked pages and pending results. */
export function suggestionRequestKey(
  input: ReturnType<typeof suggestionRequest>,
) {
  return JSON.stringify(input);
}
