"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import { AuthError } from "@/lib/auth-principal";
import { BrainError } from "@/lib/brain/types";
import { type Actor, ownerActor } from "@/lib/tasks/actors";
import {
  addTaskDependency,
  removeTaskDependency,
} from "@/lib/tasks/dependencies";
import { tasksEnabledFor } from "@/lib/tasks/feature";
import { approveTask, delegateTask, purgeTask } from "@/lib/tasks/owner";
import { addTaskParty, removeTaskParty } from "@/lib/tasks/parties";
import { createTask } from "@/lib/tasks/service";
import {
  deleteTaskView,
  saveTaskView,
  setKeeperExcluded,
  setProjectPaused,
} from "@/lib/tasks/settings";
import {
  addTaskLink,
  decideTaskLink,
  decideTaskSuggestion,
} from "@/lib/tasks/suggestions";
import { parseTaskRef } from "@/lib/tasks/types";
import { updateTasksCache } from "@/lib/workspace/cache";
import { requireWorkspaceUser } from "@/lib/workspace/session";
import {
  acceptSuggestion,
  moveTask,
  positiveVersion,
  runTaskOperation,
  saveTaskEdits,
  seenTask,
  type TaskOperation,
  type TaskOperationInput,
} from "@/lib/workspace/task-moves";
import { taskHref } from "@/lib/workspace/task-urls";

// Owner powers, reachable only from the signed-in app (Server Actions check
// the Origin against the Host). Each one: session → owner actor → service →
// typed error → rethrow framework signals → updateTag for read-your-writes.
// lib/workspace/task-moves.ts holds the checks against what the screen showed.

export type TaskActionError = {
  ok: false;
  code: string;
  message: string;
  remedy?: string;
};
export type TaskActionResult<T = null> =
  | { ok: true; value: T }
  | TaskActionError;

const FAILED: TaskActionError = {
  ok: false,
  code: "FAILED",
  message: "Unable to update the task. Try again.",
};

function failure(error: unknown): TaskActionError {
  if (error instanceof BrainError) {
    const details = (error.details ?? {}) as {
      remedy?: unknown;
      issues?: { path?: unknown; message?: unknown }[];
    };
    const issues = Array.isArray(details.issues)
      ? details.issues
          .slice(0, 3)
          .map((issue) =>
            [issue.path, issue.message].filter(Boolean).join(": "),
          )
          .join("; ")
      : "";
    return {
      ok: false,
      code: error.code,
      message: issues ? `${error.message} ${issues}` : error.message,
      ...(typeof details.remedy === "string" && !issues
        ? { remedy: details.remedy }
        : {}),
    };
  }
  if (error instanceof AuthError)
    return { ok: false, code: error.code, message: error.message };
  if (error instanceof ZodError)
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: error.issues.map((issue) => issue.message).join(" "),
    };
  console.error(
    "Task action failed",
    error instanceof Error ? error.name : "unknown error",
  );
  return FAILED;
}

async function asOwner<T>(
  operation: (actor: Actor) => Promise<T>,
): Promise<TaskActionResult<T>> {
  let ownerId: string | null = null;
  try {
    const user = await requireWorkspaceUser();
    if (!(await tasksEnabledFor(user.id)))
      return {
        ok: false,
        code: "TASKS_DISABLED",
        message: "Tasks are not enabled.",
      };
    ownerId = user.id;
    return { ok: true, value: await operation(await ownerActor(user.id)) };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  } finally {
    // Also after a failure: an action of several steps may have committed
    // its first write before a later step failed.
    if (ownerId) updateTasksCache(ownerId);
  }
}

const version = positiveVersion;
const ref = (value: unknown) => {
  if (typeof value !== "string" || !parseTaskRef(value))
    throw new BrainError("INVALID_INPUT", "That is not a task reference.", 400);
  return value;
};

export async function createTaskAction(
  input: unknown,
): Promise<TaskActionError> {
  const result = await asOwner(
    async (actor) => (await createTask(actor, input)).task.ref,
  );
  if (!result.ok) return result;
  redirect(taskHref(result.value));
}

/** Saves the changed fields, then the delegate (a separate owner power). */
export async function updateTaskAction(
  taskRef: string,
  expectedVersion: number,
  patch: Record<string, unknown>,
  delegate?: { agentId: string | null },
): Promise<TaskActionError> {
  const result = await asOwner((actor) =>
    saveTaskEdits(actor, ref(taskRef), expectedVersion, patch, delegate),
  );
  if (!result.ok) return result;
  redirect(taskHref(result.value));
}

/** "Delegate to…": only that agent may claim; null opens it to any agent. */
export async function delegateTaskAction(
  taskRef: string,
  expectedVersion: number,
  agentId: string | null,
): Promise<TaskActionResult<{ version: number }>> {
  return asOwner(async (actor) => {
    const task = await delegateTask(actor, ref(taskRef), {
      expectedVersion: version(expectedVersion),
      agentId: typeof agentId === "string" && agentId ? agentId : null,
    });
    return { version: task.version };
  });
}

/**
 * One owner transition on one task; returns the task's new version. A claim
 * count or a question time in the input must still match the task.
 */
export async function taskOperationAction(
  taskRef: string,
  operation: TaskOperation,
  input: TaskOperationInput = {},
): Promise<TaskActionResult<{ ref: string; status: string; version: number }>> {
  return asOwner(async (actor) => {
    const task = await runTaskOperation(actor, ref(taskRef), operation, input);
    return { ref: task.ref, status: task.status, version: task.version };
  });
}

/** A board move, refused when the card is older than the committed task. */
export async function moveTaskAction(
  taskRef: string,
  from: string,
  to: string,
  input: TaskOperationInput = {},
): Promise<TaskActionResult<{ ref: string; status: string; version: number }>> {
  return asOwner(async (actor) => {
    const task = await moveTask(
      actor,
      ref(taskRef),
      String(from),
      String(to),
      input,
    );
    return { ref: task.ref, status: task.status, version: task.version };
  });
}

/** "Approve all" for a source batch: each task is checked against its version. */
export async function approveTasksAction(
  items: { ref: string; expectedVersion: number }[],
): Promise<
  TaskActionResult<{
    approved: string[];
    failed: { ref: string; message: string }[];
  }>
> {
  return asOwner(async (actor) => {
    const approved: string[] = [];
    const failed: { ref: string; message: string }[] = [];
    for (const item of (Array.isArray(items) ? items : []).slice(0, 100)) {
      try {
        const task = await approveTask(actor, ref(item.ref), {
          expectedVersion: version(item.expectedVersion),
        });
        approved.push(task.ref);
      } catch (error) {
        unstable_rethrow(error);
        failed.push({
          ref: String(item.ref),
          message: failure(error).message,
        });
      }
    }
    return { approved, failed };
  });
}

/**
 * Accepting runs the suggestion's prefilled transition as the owner, only
 * while it still applies to the task the card showed (`seen`).
 */
export async function decideSuggestionAction(
  id: string,
  decision: "accepted" | "dismissed",
  seen?: { version?: number; status?: string; claimCount?: number },
): Promise<TaskActionResult<{ ref: string | null; ran: string | null }>> {
  return asOwner(async (actor) => {
    if (decision === "accepted")
      return acceptSuggestion(actor, String(id), {
        ...seenTask(seen),
        inputRequestedAt: undefined,
      });
    await decideTaskSuggestion(actor, { id, decision: "dismissed" });
    return { ref: null, ran: null };
  });
}

export async function decideLinkAction(
  taskRef: string,
  pageId: string,
  role: string,
  decision: "active" | "rejected",
): Promise<TaskActionResult> {
  return asOwner(async (actor) => {
    await decideTaskLink(actor, ref(taskRef), {
      pageRef: pageId,
      role,
      decision,
    });
    return null;
  });
}

export async function addLinkAction(
  taskRef: string,
  pageId: string,
  role: string,
): Promise<TaskActionResult> {
  return asOwner(async (actor) => {
    await addTaskLink(actor, ref(taskRef), { pageRef: pageId, role });
    return null;
  });
}

export async function addPartyAction(
  taskRef: string,
  party: Record<string, unknown>,
): Promise<TaskActionResult> {
  return asOwner(async (actor) => {
    await addTaskParty(actor, ref(taskRef), party);
    return null;
  });
}

export async function removePartyAction(
  taskRef: string,
  partyId: string,
): Promise<TaskActionResult> {
  return asOwner(async (actor) => {
    await removeTaskParty(actor, ref(taskRef), String(partyId));
    return null;
  });
}

export async function dependencyAction(
  taskRef: string,
  dependsOnRef: string,
  present: boolean,
): Promise<TaskActionResult> {
  return asOwner(async (actor) => {
    if (present)
      await addTaskDependency(actor, ref(taskRef), ref(dependsOnRef));
    else await removeTaskDependency(actor, ref(taskRef), ref(dependsOnRef));
    return null;
  });
}

export async function saveViewAction(
  name: string,
  query: string,
): Promise<TaskActionResult> {
  return asOwner(async (actor) => {
    await saveTaskView(actor, { name, query });
    return null;
  });
}

export async function deleteViewAction(id: string): Promise<TaskActionResult> {
  return asOwner(async (actor) => {
    await deleteTaskView(actor, String(id));
    return null;
  });
}

/** Pausing stops queue claims for the project; claims on request still work. */
export async function pauseProjectAction(
  projectId: string,
  paused: boolean,
): Promise<TaskActionResult> {
  return asOwner(async (actor) => {
    await setProjectPaused(actor, String(projectId), Boolean(paused));
    return null;
  });
}

export async function excludeFromKeeperAction(
  pageId: string,
  excluded: boolean,
): Promise<TaskActionResult> {
  return asOwner(async (actor) => {
    await setKeeperExcluded(actor, String(pageId), Boolean(excluded));
    return null;
  });
}

/** Purge needs the task reference typed back; only a text-free event remains. */
export async function purgeTaskAction(
  taskRef: string,
  confirmation: string,
): Promise<TaskActionError> {
  const result = await asOwner(async (actor) => {
    const target = ref(taskRef);
    const typed = parseTaskRef(String(confirmation));
    const expected = parseTaskRef(target);
    if (
      !typed ||
      !expected ||
      JSON.stringify(typed) !== JSON.stringify(expected)
    )
      throw new BrainError(
        "INVALID_INPUT",
        `Type ${target} to confirm the purge.`,
        400,
      );
    await purgeTask(actor, target);
    return null;
  });
  if (!result.ok) return result;
  redirect("/tasks");
}

/** "Load latest version": expire the cached task views for this owner. */
export async function refreshTasksAction(): Promise<TaskActionResult> {
  return asOwner(async () => null);
}
