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
