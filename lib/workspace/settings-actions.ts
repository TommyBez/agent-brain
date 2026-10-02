"use server";

import { revalidatePath } from "next/cache";
import { createAgentToken, revokeAgentToken } from "@/lib/agent-tokens";
import { AuthError } from "@/lib/auth-principal";
import { startNightlyMaintenance } from "@/lib/maintenance/start";
import { requireWorkspaceUser } from "@/lib/workspace/session";

export async function createTokenAction(form: FormData) {
  const user = await requireWorkspaceUser();
  try {
    const result = await createAgentToken(user.id, {
      name: form.get("name"),
      scopes: form.getAll("scopes"),
      expiresInDays: Number(form.get("days")),
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
