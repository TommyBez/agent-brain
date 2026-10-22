import { configuredAppOrigin } from "../app-origin";

/** What the caller should do next: a tool call, or a step only the owner can take. */
export type NextAction =
  | {
      kind: "tool";
      tool: string;
      args?: Record<string, unknown>;
      reason: string;
    }
  | { kind: "owner_action"; label: string; url: string };

export const POLL_AFTER_SECONDS = 60;
export const RETRY_AFTER_SECONDS = 300;

/** Anchors of /tasks/[ref] that the app opens for the owner. */
export type OwnerAnchor =
  | "approve"
  | "answer"
  | "review"
  | "unblock"
  | "delegate"
  | "revoke";

export function ownerActionUrl(ref: string, anchor: OwnerAnchor): string {
  const path = `/tasks/${ref}#${anchor}`;
  try {
    const origin = configuredAppOrigin();
    return origin ? new URL(path, origin).toString() : path;
  } catch {
    return path;
  }
}

export function ownerAction(
  ref: string,
  anchor: OwnerAnchor,
  label: string,
): NextAction {
  return { kind: "owner_action", label, url: ownerActionUrl(ref, anchor) };
}
