import "server-only";

import { cacheLife, cacheTag } from "next/cache";
import { cache } from "react";
import { listPagesSchema } from "@/lib/brain/schemas";
import * as brain from "@/lib/brain/service";
import { workspaceCacheTag } from "./cache";
import { getWorkspaceUser } from "./session";

export type WorkspacePageOptions = {
  query?: string;
  type?: string;
  sort?: "updated" | "title";
  limit?: number;
  offset?: number;
};

async function statsForOwner(ownerId: string) {
  "use cache";
  cacheTag(workspaceCacheTag(ownerId));
  cacheLife({ stale: 30, revalidate: 30, expire: 60 });
  return brain.getStats(ownerId);
}

async function pagesForOwner(
  ownerId: string,
  options: ReturnType<typeof listPagesSchema.parse>,
) {
  "use cache";
  cacheTag(workspaceCacheTag(ownerId));
  cacheLife({ stale: 30, revalidate: 30, expire: 60 });
  return brain.listPages(ownerId, options);
}

async function pageForOwner(ownerId: string, id: string) {
  "use cache";
  cacheTag(workspaceCacheTag(ownerId));
  cacheLife({ stale: 30, revalidate: 30, expire: 60 });
  return brain.read(ownerId, { ref: id });
}

async function revisionsForOwner(ownerId: string, id: string) {
  "use cache";
  cacheTag(workspaceCacheTag(ownerId));
  cacheLife({ stale: 30, revalidate: 30, expire: 60 });
  return brain.listRevisions(ownerId, { ref: id, limit: 50 });
}

async function graphForOwner(ownerId: string) {
  "use cache";
  cacheTag(workspaceCacheTag(ownerId));
  cacheLife({ stale: 30, revalidate: 30, expire: 60 });
  return brain.getGraph(ownerId, { limit: 200 });
}

async function activityForOwner(ownerId: string) {
  "use cache";
  cacheTag(workspaceCacheTag(ownerId));
  cacheLife({ stale: 30, revalidate: 30, expire: 60 });
  return brain.listActivity(ownerId, { limit: 50 });
}

// Authorize outside every cache boundary. Only these owner-free getters are
// exported, so callers cannot select another user's cache entry.
export const getWorkspaceStats = cache(async () => {
  const user = await getWorkspaceUser();
  return statsForOwner(user.id);
});

export async function getWorkspacePages(options: WorkspacePageOptions = {}) {
  const user = await getWorkspaceUser();
  return pagesForOwner(user.id, listPagesSchema.parse(options));
}

export const getWorkspacePage = cache(async (id: string) => {
  const user = await getWorkspaceUser();
  return pageForOwner(user.id, id);
});

export const getWorkspaceRevisions = cache(async (id: string) => {
  const user = await getWorkspaceUser();
  return revisionsForOwner(user.id, id);
});

export const getWorkspaceGraph = cache(async () => {
  const user = await getWorkspaceUser();
  return graphForOwner(user.id);
});

export const getWorkspaceActivity = cache(async () => {
  const user = await getWorkspaceUser();
  return activityForOwner(user.id);
});
