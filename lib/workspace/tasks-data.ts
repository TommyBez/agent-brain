import "server-only";

import { cacheLife, cacheTag } from "next/cache";
import { cache } from "react";
import { tasksEnabledFor } from "@/lib/tasks/feature";
import { tasksCacheTag, workspaceCacheTag } from "./cache";
import { getWorkspaceUser } from "./session";
import {
  queryKeeperExclusions,
  queryNeedsYou,
  queryPersonTasks,
  queryProjectTasks,
  querySuggestions,
  queryTaskActivity,
  queryTaskBoard,
  queryTaskCalendar,
  queryTaskDetail,
  queryTaskFormChoices,
  queryTaskKnowledge,
  queryTaskOverview,
  queryTaskParties,
  queryTaskSettings,
  queryTaskTable,
} from "./task-queries";
import type { TaskBoardFilters, TaskListFilters } from "./task-urls";

// Two levels, as in data.ts: an exported getter authorizes the session, then
// an unexported `use cache` function keyed by the owner reads. Task views use
// the tasks tag; views that also show page titles or passages carry the
// workspace tag too, so a page write never leaves them stale. Every task row
// carries its project's title and slug, so only reads without task rows or
// pages (activity, form choices, settings) are tasks-only.

function tag(ownerId: string, pages: boolean) {
  if (pages) cacheTag(tasksCacheTag(ownerId), workspaceCacheTag(ownerId));
  else cacheTag(tasksCacheTag(ownerId));
  cacheLife({ stale: 30, revalidate: 30, expire: 60 });
}
const tasksOnly = (ownerId: string) => tag(ownerId, false);
const withPages = (ownerId: string) => tag(ownerId, true);

async function needsYouForOwner(ownerId: string) {
  "use cache";
  withPages(ownerId);
  return queryNeedsYou(ownerId);
}

async function overviewForOwner(ownerId: string) {
  "use cache";
  withPages(ownerId);
  return queryTaskOverview(ownerId);
}

async function tableForOwner(ownerId: string, filters: TaskListFilters) {
  "use cache";
  withPages(ownerId);
  return queryTaskTable(ownerId, filters);
}

async function detailForOwner(ownerId: string, ref: string) {
  "use cache";
  withPages(ownerId);
  return queryTaskDetail(ownerId, ref);
}

async function knowledgeForOwner(ownerId: string, taskId: string) {
  "use cache";
  withPages(ownerId);
  return queryTaskKnowledge(ownerId, taskId);
}

async function activityForOwner(ownerId: string, taskId: string) {
  "use cache";
  tasksOnly(ownerId);
  return queryTaskActivity(ownerId, taskId);
}

async function partiesForOwner(ownerId: string, taskId: string) {
  "use cache";
  withPages(ownerId);
  return queryTaskParties(ownerId, taskId);
}

async function suggestionsForOwner(ownerId: string, taskId: string) {
  "use cache";
  withPages(ownerId);
  return querySuggestions(ownerId, taskId);
}

async function calendarForOwner(ownerId: string, from: string, to: string) {
  "use cache";
  withPages(ownerId);
  return queryTaskCalendar(ownerId, from, to);
}

async function boardForOwner(ownerId: string, filters: TaskBoardFilters) {
  "use cache";
  withPages(ownerId);
  return queryTaskBoard(ownerId, filters);
}

async function projectTasksForOwner(ownerId: string, pageId: string) {
  "use cache";
  withPages(ownerId);
  return queryProjectTasks(ownerId, pageId);
}

async function personTasksForOwner(ownerId: string, pageId: string) {
  "use cache";
  withPages(ownerId);
  return queryPersonTasks(ownerId, pageId);
}

async function formChoicesForOwner(ownerId: string) {
  "use cache";
  tasksOnly(ownerId);
  return queryTaskFormChoices(ownerId);
}

async function settingsForOwner(ownerId: string) {
  "use cache";
  tasksOnly(ownerId);
  return queryTaskSettings(ownerId);
}

async function tasksEnabledForOwner(ownerId: string) {
  "use cache";
  tasksOnly(ownerId);
  return tasksEnabledFor(ownerId);
}

async function keeperExclusionsForOwner(ownerId: string) {
  "use cache";
  withPages(ownerId);
  return queryKeeperExclusions(ownerId);
}

// Authorize outside every cache boundary; only owner-free getters are exported.

/** The signed-in owner's task manager switch; every task view checks it. */
export const getTasksEnabled = cache(async () => {
  const user = await getWorkspaceUser();
  return tasksEnabledForOwner(user.id);
});

export const getNeedsYou = cache(async () => {
  const user = await getWorkspaceUser();
  return needsYouForOwner(user.id);
});

export const getTaskOverview = cache(async () => {
  const user = await getWorkspaceUser();
  return overviewForOwner(user.id);
});

export async function getTaskTable(filters: TaskListFilters) {
  const user = await getWorkspaceUser();
  return tableForOwner(user.id, filters);
}

export const getTaskDetail = cache(async (ref: string) => {
  const user = await getWorkspaceUser();
  return detailForOwner(user.id, ref);
});

export const getTaskKnowledge = cache(async (taskId: string) => {
  const user = await getWorkspaceUser();
  return knowledgeForOwner(user.id, taskId);
});

export const getTaskActivity = cache(async (taskId: string) => {
  const user = await getWorkspaceUser();
  return activityForOwner(user.id, taskId);
});

export const getTaskParties = cache(async (taskId: string) => {
  const user = await getWorkspaceUser();
  return partiesForOwner(user.id, taskId);
});

export const getTaskSuggestions = cache(async (taskId: string) => {
  const user = await getWorkspaceUser();
  return suggestionsForOwner(user.id, taskId);
});

export async function getTaskCalendar(from: string, to: string) {
  const user = await getWorkspaceUser();
  return calendarForOwner(user.id, from, to);
}

export async function getTaskBoard(filters: TaskBoardFilters) {
  const user = await getWorkspaceUser();
  return boardForOwner(user.id, filters);
}

export const getProjectTasks = cache(async (pageId: string) => {
  const user = await getWorkspaceUser();
  return projectTasksForOwner(user.id, pageId);
});

export const getPersonTasks = cache(async (pageId: string) => {
  const user = await getWorkspaceUser();
  return personTasksForOwner(user.id, pageId);
});

export const getTaskFormChoices = cache(async () => {
  const user = await getWorkspaceUser();
  return formChoicesForOwner(user.id);
});

export const getTaskSettingsView = cache(async () => {
  const user = await getWorkspaceUser();
  return settingsForOwner(user.id);
});

export const getKeeperExclusions = cache(async () => {
  const user = await getWorkspaceUser();
  return keeperExclusionsForOwner(user.id);
});
