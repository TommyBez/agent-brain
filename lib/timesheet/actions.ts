"use server";

import { updateTag } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { BrainError } from "../brain/types";
import { ownerActor } from "../tasks/actors";
import { timesheetCacheTag } from "../workspace/cache";
import { requireWorkspaceUser } from "../workspace/session";
import { createTimeEntry, deleteTimeEntry, updateTimeEntry } from "./service";

export async function saveTimeEntryAction(input: unknown, edit = false) {
  const user = await requireWorkspaceUser();
  try {
    const actor = await ownerActor(user.id);
    if (edit) await updateTimeEntry(actor, input);
    else await createTimeEntry(actor, input);
    updateTag(timesheetCacheTag(user.id));
    return { ok: true as const };
  } catch (error) {
    unstable_rethrow(error);
    return {
      error:
        error instanceof BrainError
          ? error.message
          : "Unable to save time. Try again.",
    };
  }
}

export async function deleteTimeEntryAction(input: unknown) {
  const user = await requireWorkspaceUser();
  try {
    await deleteTimeEntry(await ownerActor(user.id), input);
    updateTag(timesheetCacheTag(user.id));
    return { ok: true as const };
  } catch (error) {
    unstable_rethrow(error);
    return {
      error:
        error instanceof BrainError
          ? error.message
          : "Unable to delete time. Try again.",
    };
  }
}
