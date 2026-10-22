import { failure, json, owner } from "@/app/api/shared";
import { tasksEnabledFor } from "@/lib/tasks/feature";
import { getTaskSettings } from "@/lib/tasks/settings";
import {
  queryNeedsYouCount,
  queryTaskWatermark,
  TASK_WATERMARK,
} from "@/lib/workspace/task-queries";
import { savedViewHref } from "@/lib/workspace/task-urls";

// The app's cheap "did anything change?" poll. The cursor is the highest
// event id plus a stamp of suggestions and settings, which change without an
// event; a browser only needs to know whether to re-render, while agents
// keep the commit-safe xid8 cursor of list_tasks{changedSince}. The Needs
// you count and saved views ride along only when something changed. While
// the owner's task manager is off the poll answers 404, as tasks are hidden.

export async function GET(request: Request) {
  try {
    const ownerId = await owner(request);
    // The switch and the watermark are read in parallel.
    const [enabled, latest] = await Promise.all([
      tasksEnabledFor(ownerId),
      queryTaskWatermark(ownerId),
    ]);
    if (!enabled)
      return json({ error: "Tasks are not enabled.", code: "NOT_FOUND" }, 404);
    const after = new URL(request.url).searchParams.get("after");
    const known = after && TASK_WATERMARK.test(after) ? after : null;
    if (known !== null && known === latest)
      return json({ latest, changed: false });
    const [needsYou, settings] = await Promise.all([
      queryNeedsYouCount(ownerId),
      getTaskSettings(ownerId),
    ]);
    return json({
      latest,
      changed: known !== null,
      needsYou,
      views: settings.savedViews.map((view) => ({
        id: view.id,
        name: view.name,
        href: savedViewHref(view.query),
      })),
    });
  } catch (error) {
    return failure(error);
  }
}
