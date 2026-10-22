"use server";

import { revalidatePath } from "next/cache";
import { createAgentToken, revokeAgentToken } from "@/lib/agent-tokens";
import { AuthError } from "@/lib/auth-principal";
import { BrainError } from "@/lib/brain/types";
import {
  startNightlyMaintenance,
  startTaskMaintenance,
} from "@/lib/maintenance/start";
import type { AgentPatch } from "@/lib/tasks/actors";
import {
  setRegistryAgentDisabled,
  updateRegistryAgent,
} from "@/lib/workspace/agent-registry";
import { updateTasksCache, updateWorkspaceCache } from "@/lib/workspace/cache";
import { requireWorkspaceUser } from "@/lib/workspace/session";

export async function createTokenAction(form: FormData) {
  const user = await requireWorkspaceUser();
  const agentId = form.get("agentId");
  try {
    const result = await createAgentToken(user.id, {
      name: form.get("name"),
      scopes: form.getAll("scopes"),
      expiresInDays: Number(form.get("days")),
      ...(agentId ? { agentId } : {}),
    });
    revalidatePath("/agents");
    return { token: result.token };
  } catch (error) {
    return {
      error:
        error instanceof AuthError
          ? error.message
          : "Unable to create token. Try again.",
    };
  }
}

export async function revokeTokenAction(id: string) {
  const user = await requireWorkspaceUser();
  try {
    await revokeAgentToken(user.id, { id });
    revalidatePath("/agents");
    return { revoked: true };
  } catch (error) {
    return {
      error:
        error instanceof AuthError
          ? error.message
          : "Unable to revoke token. Try again.",
    };
  }
}

export async function runMaintenanceAction() {
  const user = await requireWorkspaceUser();
  try {
    const run = await startNightlyMaintenance(user.id, "manual");
    revalidatePath("/operations");
    return { completed: run.completed };
  } catch {
    return {
      error: "Unable to start maintenance. Check Operations and try again.",
    };
  }
}

/** Runs only today's task keeper and task links, without the other stages. */
export async function runTaskMaintenanceAction() {
  const user = await requireWorkspaceUser();
  try {
    const run = await startTaskMaintenance(user.id);
    revalidatePath("/operations");
    return { started: run.started };
  } catch (error) {
    return {
      error:
        error instanceof BrainError && error.code === "TASKS_DISABLED"
          ? "Task maintenance is not enabled."
          : "Unable to start task maintenance. Check Operations and try again.",
    };
  }
}

// Agent registry (/agents). Owner session only; Server Actions also reject
// cross-origin posts. Labels appear in revision and task history, so both
// caches are refreshed.

function registryError(error: unknown, fallback: string) {
  return error instanceof BrainError ? error.message : fallback;
}

export async function updateAgentAction(agentId: string, patch: AgentPatch) {
  const user = await requireWorkspaceUser();
  try {
    await updateRegistryAgent(user.id, agentId, patch);
  } catch (error) {
    return {
      error: registryError(error, "Unable to save this agent. Try again."),
    };
  }
  updateWorkspaceCache(user.id);
  updateTasksCache(user.id);
  revalidatePath("/agents");
  return { saved: true };
}

/** Takes effect on the agent's next request; the owner and system agents never are. */
export async function setAgentDisabledAction(
  agentId: string,
  disabled: boolean,
) {
  const user = await requireWorkspaceUser();
  try {
    await setRegistryAgentDisabled(user.id, agentId, disabled === true);
  } catch (error) {
    return {
      error: registryError(
        error,
        disabled
          ? "Unable to disable this agent. Try again."
          : "Unable to enable this agent. Try again.",
      ),
    };
  }
  updateTasksCache(user.id);
  revalidatePath("/agents");
  return { disabled: disabled === true };
}
