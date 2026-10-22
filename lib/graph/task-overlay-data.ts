import "server-only";

import { cacheLife, cacheTag } from "next/cache";
import { tasksCacheTag, workspaceCacheTag } from "@/lib/workspace/cache";
import { getWorkspaceUser } from "@/lib/workspace/session";
import { getTasksEnabled } from "@/lib/workspace/tasks-data";
import { EMPTY_TASK_OVERLAY, type TaskOverlay } from "./task-overlay";
import { loadTaskOverlay } from "./task-overlay-query";

// Task state and page links both shape the layer, so either tag expires it.
async function overlayForOwner(ownerId: string, pageIds: string[]) {
  "use cache";
  cacheTag(tasksCacheTag(ownerId), workspaceCacheTag(ownerId));
  cacheLife({ stale: 30, revalidate: 30, expire: 60 });
  return loadTaskOverlay(ownerId, pageIds);
}

/** The open-task layer for the pages on screen; empty while tasks are off. */
export async function getWorkspaceTaskOverlay(
  pageIds: string[],
): Promise<TaskOverlay> {
  // The same per-request read as the page's own check: no extra query.
  if (!(await getTasksEnabled())) return EMPTY_TASK_OVERLAY;
  const user = await getWorkspaceUser();
  return overlayForOwner(user.id, pageIds);
}
