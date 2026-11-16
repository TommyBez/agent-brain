import "server-only";

import { cacheLife, cacheTag } from "next/cache";
import type { z } from "zod";
import { getPool } from "../db";
import { timesheetCacheTag, workspaceCacheTag } from "../workspace/cache";
import { getWorkspaceUser } from "../workspace/session";
import type { listTimeEntriesSchema } from "./schemas";
import { listTimeEntries } from "./service";

async function dataForOwner(
  ownerId: string,
  filters: z.input<typeof listTimeEntriesSchema>,
) {
  "use cache";
  cacheTag(timesheetCacheTag(ownerId), workspaceCacheTag(ownerId));
  cacheLife({ stale: 30, revalidate: 30, expire: 60 });
  const [result, projects] = await Promise.all([
    listTimeEntries(ownerId, filters),
    getPool().query<{ id: string; title: string }>(
      "SELECT id, title FROM brain_pages WHERE owner_id = $1 AND type = 'project' ORDER BY title, id",
      [ownerId],
    ),
  ]);
  return { ...result, projects: projects.rows };
}

export async function getTimesheet(
  filters: z.input<typeof listTimeEntriesSchema>,
) {
  return dataForOwner((await getWorkspaceUser()).id, filters);
}
