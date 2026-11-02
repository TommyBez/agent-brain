"use server";

import { ownerActor } from "@/lib/tasks/actors";
import { tasksEnabledFor } from "@/lib/tasks/feature";
import { suggestTaskLinks } from "@/lib/tasks/link-candidates";
import { requireWorkspaceUser } from "@/lib/workspace/session";

export async function suggestTaskLinksAction(input: unknown) {
  const user = await requireWorkspaceUser();
  if (!(await tasksEnabledFor(user.id)))
    throw new Error("Tasks are not enabled.");
  return suggestTaskLinks(await ownerActor(user.id), input);
}
