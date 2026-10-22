"use server";

import { unstable_rethrow } from "next/navigation";
import { BrainError } from "@/lib/brain/types";
import { ownerActor } from "@/lib/tasks/actors";
import { createMeetingSeries } from "@/lib/tasks/meetings";
import {
  setRecurrencePaused,
  todayInTaskZone,
  WEEKDAYS,
} from "@/lib/tasks/recurrences";
import { tasksEnabled } from "@/lib/tasks/types";
import { updateTasksCache } from "@/lib/workspace/cache";
import { requireWorkspaceUser } from "@/lib/workspace/session";

// Meeting series are owner settings: session → owner actor → service →
// updateTag. Nothing here is reachable from MCP.

export type AgendaActionResult =
  | { ok: true; id: string }
  | { ok: false; message: string };

function failure(error: unknown): AgendaActionResult {
  if (error instanceof BrainError) {
    const details = (error.details ?? {}) as {
      issues?: { path?: string; message?: string }[];
    };
    const issue = details.issues?.[0];
    return {
      ok: false,
      message: issue
        ? `${error.message} ${[issue.path, issue.message].filter(Boolean).join(": ")}`
        : error.message,
    };
  }
  console.error(
    "Agenda action failed",
    error instanceof Error ? error.name : "unknown error",
  );
  return {
    ok: false,
    message: "Unable to save the meeting series. Try again.",
  };
}

async function asOwner(
  operation: (actor: Awaited<ReturnType<typeof ownerActor>>) => Promise<string>,
): Promise<AgendaActionResult> {
  let ownerId: string;
  let id: string;
  try {
    const user = await requireWorkspaceUser();
    if (!tasksEnabled())
      return { ok: false, message: "Tasks are not enabled." };
    ownerId = user.id;
    id = await operation(await ownerActor(user.id));
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
  updateTasksCache(ownerId);
  return { ok: true, id };
}

export interface MeetingSeriesInput {
  title: string;
  projectId: string;
  weekday: string;
  interval: number;
  time: string;
  startsOn: string;
}

/** A weekly meeting series: every `interval` weeks on one weekday. */
export async function createMeetingSeriesAction(
  input: MeetingSeriesInput,
): Promise<AgendaActionResult> {
  return asOwner(async (actor) => {
    const weekday = String(input?.weekday ?? "");
    if (!(WEEKDAYS as readonly string[]).includes(weekday))
      throw new BrainError("INVALID_INPUT", "Choose the meeting's weekday.");
    const interval = Number(input?.interval);
    if (!Number.isInteger(interval) || interval < 1 || interval > 8)
      throw new BrainError("INVALID_INPUT", "Repeat every 1 to 8 weeks.");
    const series = await createMeetingSeries(actor, {
      title: input?.title,
      projectRef: input?.projectId,
      rrule: `FREQ=WEEKLY;INTERVAL=${interval};BYDAY=${weekday}`,
      startsOn: input?.startsOn || todayInTaskZone(),
      ...(input?.time ? { time: input.time } : {}),
    });
    return series.id;
  });
}

export async function setMeetingSeriesPausedAction(
  id: string,
  paused: boolean,
): Promise<AgendaActionResult> {
  return asOwner(async (actor) => {
    const series = await setRecurrencePaused(
      actor,
      String(id),
      paused === true,
    );
    return series.id;
  });
}
