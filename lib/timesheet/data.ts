import "server-only";

import { cacheLife, cacheTag } from "next/cache";
import type { z } from "zod";
import { getPool } from "../db";
import { timesheetCacheTag, workspaceCacheTag } from "../workspace/cache";
import { getWorkspaceUser } from "../workspace/session";
import type { listTimeEntriesSchema } from "./schemas";
import { listTimeEntries, listTimesheetMonth } from "./service";

async function entriesForOwner(
  ownerId: string,
  filters: z.input<typeof listTimeEntriesSchema>,
) {
  "use cache";
  cacheTag(timesheetCacheTag(ownerId), workspaceCacheTag(ownerId));
  cacheLife({ stale: 30, revalidate: 30, expire: 60 });
  return listTimeEntries(ownerId, filters);
}

async function monthForOwner(
  ownerId: string,
  filters: Parameters<typeof listTimesheetMonth>[1],
) {
  "use cache";
  cacheTag(timesheetCacheTag(ownerId), workspaceCacheTag(ownerId));
  cacheLife({ stale: 30, revalidate: 30, expire: 60 });
  return listTimesheetMonth(ownerId, filters);
}

async function projectsForOwner(ownerId: string) {
  "use cache";
  cacheTag(timesheetCacheTag(ownerId), workspaceCacheTag(ownerId));
  cacheLife({ stale: 30, revalidate: 30, expire: 60 });
  const { rows } = await getPool().query<{
    id: string;
    slug: string;
    title: string;
    type: string;
  }>(
    `SELECT p.id, p.slug, p.title, p.type FROM brain_pages p WHERE p.owner_id = $1
       AND (p.type = 'project' OR EXISTS (
         SELECT 1 FROM brain_time_entries e WHERE e.owner_id = p.owner_id AND e.project_id = p.id
       )) ORDER BY p.title, p.id`,
    [ownerId],
  );
  return rows;
}

function projectOptions(
  filterProjects: Awaited<ReturnType<typeof projectsForOwner>>,
  projectRef: string | null | undefined,
) {
  const selected = filterProjects.find(
    (page) => page.id === projectRef || page.slug === projectRef,
  );
  return {
    filterProjects,
    projects: filterProjects.filter((page) => page.type === "project"),
    project: selected?.id ?? (projectRef === null ? "none" : ""),
    projectId: selected?.type === "project" ? selected.id : undefined,
  };
}

export async function getTimesheet(
  filters: z.input<typeof listTimeEntriesSchema>,
) {
  const { id } = await getWorkspaceUser();
  const [result, filterProjects] = await Promise.all([
    entriesForOwner(id, filters),
    projectsForOwner(id),
  ]);
  return { ...result, ...projectOptions(filterProjects, filters.projectRef) };
}

export async function getTimesheetMonth(
  filters: Parameters<typeof listTimesheetMonth>[1],
) {
  const { id } = await getWorkspaceUser();
  const [result, filterProjects] = await Promise.all([
    monthForOwner(id, filters),
    projectsForOwner(id),
  ]);
  return { ...result, ...projectOptions(filterProjects, filters.projectRef) };
}
