import { revalidateTag, updateTag } from "next/cache";

export function workspaceCacheTag(ownerId: string) {
  return `workspace:${ownerId}`;
}

/** Server Actions provide read-your-writes, including counts and backlinks. */
export function updateWorkspaceCache(ownerId: string) {
  updateTag(workspaceCacheTag(ownerId));
}

/** HTTP/MCP and Workflow step adapters expire data after a committed mutation. */
export function revalidateWorkspaceCache(ownerId: string) {
  revalidateTag(workspaceCacheTag(ownerId), { expire: 0 });
}

/** Task state has its own tag: claims and renewals never expire knowledge views. */
export function tasksCacheTag(ownerId: string) {
  return `tasks:${ownerId}`;
}

export function updateTasksCache(ownerId: string) {
  updateTag(tasksCacheTag(ownerId));
}

export function revalidateTasksCache(ownerId: string) {
  revalidateTag(tasksCacheTag(ownerId), { expire: 0 });
}

export type CacheInvalidation = "workspace" | "tasks" | "both";

/** The MCP route's onMutation: expire only what the tool changed. */
export function revalidateAfterMutation(
  ownerId: string,
  kind: CacheInvalidation,
) {
  if (kind !== "tasks") revalidateWorkspaceCache(ownerId);
  if (kind !== "workspace") revalidateTasksCache(ownerId);
}
