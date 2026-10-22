import "server-only";

import { cacheLife, cacheTag } from "next/cache";
import { cache } from "react";
import { revisionActors } from "./agent-registry";
import { workspaceCacheTag } from "./cache";
import { WORKSPACE_PAGE_SIZE } from "./pagination";
import { getWorkspaceUser } from "./session";

// Who signed each revision. Agent renames refresh the workspace tag.

async function actorsForOwner(ownerId: string, id: string, offset: number) {
  "use cache";
  cacheTag(workspaceCacheTag(ownerId));
  cacheLife({ stale: 30, revalidate: 30, expire: 60 });
  return revisionActors(ownerId, id, {
    limit: WORKSPACE_PAGE_SIZE + 1,
    offset,
  });
}

async function actorForOwner(ownerId: string, id: string, version: number) {
  "use cache";
  cacheTag(workspaceCacheTag(ownerId));
  cacheLife({ stale: 30, revalidate: 30, expire: 60 });
  return revisionActors(ownerId, id, { version });
}

/** Actors for the same window as getWorkspaceRevisions, keyed by version. */
export const getWorkspaceRevisionActors = cache(
  async (id: string, offset = 0) => {
    const user = await getWorkspaceUser();
    return actorsForOwner(user.id, id, offset);
  },
);

export const getWorkspaceRevisionActor = cache(
  async (id: string, version: number) => {
    const user = await getWorkspaceUser();
    return (await actorForOwner(user.id, id, version))[version] ?? null;
  },
);
