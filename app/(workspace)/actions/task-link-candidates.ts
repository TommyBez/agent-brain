"use server";

import { requireWorkspaceUser } from "@/lib/workspace/session";
import { suggestPagesForOwner } from "@/lib/workspace/task-link-candidates";

export async function suggestTaskLinksAction(input: unknown) {
  return suggestPagesForOwner(input, requireWorkspaceUser);
}
