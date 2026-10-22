import "server-only";

import { cacheLife, cacheTag, io } from "next/cache";
import * as brain from "@/lib/brain/service";
import { agendaMarkdown, getMeetingAgenda } from "@/lib/tasks/agenda";
import { listMeetingSeries } from "@/lib/tasks/meetings";
import { todayInTaskZone } from "@/lib/tasks/recurrences";
import { tasksCacheTag, workspaceCacheTag } from "@/lib/workspace/cache";
import { getWorkspaceUser } from "@/lib/workspace/session";

// Agenda reads, in the two levels of lib/workspace/data.ts: the exported
// getter authorizes the session; the `use cache` function is keyed by the
// owner and the owner's calendar day. Project titles carry the page tag too.

function tagged(ownerId: string) {
  cacheTag(tasksCacheTag(ownerId), workspaceCacheTag(ownerId));
  cacheLife({ stale: 30, revalidate: 30, expire: 60 });
}

async function seriesForOwner(ownerId: string, today: string) {
  "use cache";
  tagged(ownerId);
  return listMeetingSeries(ownerId, today);
}

async function agendaForOwner(ownerId: string, id: string, today: string) {
  "use cache";
  tagged(ownerId);
  const agenda = await getMeetingAgenda(ownerId, id, today);
  return agenda ? { agenda, markdown: agendaMarkdown(agenda) } : null;
}

async function projectsForOwner(ownerId: string) {
  "use cache";
  tagged(ownerId);
  const { pages } = await brain.listPages(ownerId, {
    type: "project",
    sort: "title",
    limit: 100,
  });
  return pages.map((page) => ({ id: page.id, title: page.title }));
}

async function ownerDay() {
  const user = await getWorkspaceUser();
  await io();
  return { ownerId: user.id, today: todayInTaskZone() };
}

export async function getMeetingSeriesList() {
  const { ownerId, today } = await ownerDay();
  return seriesForOwner(ownerId, today);
}

export async function getAgendaView(seriesId: string) {
  const { ownerId, today } = await ownerDay();
  return agendaForOwner(ownerId, seriesId, today);
}

export async function getAgendaProjects() {
  const user = await getWorkspaceUser();
  return projectsForOwner(user.id);
}
