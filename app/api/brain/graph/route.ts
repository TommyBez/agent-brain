import { failure, json, owner } from "@/app/api/shared";
import { getGraph } from "@/lib/brain/service";
import { parseTaskOverlayParam } from "@/lib/graph/task-overlay";
import { loadTaskOverlay } from "@/lib/graph/task-overlay-query";
import { tasksEnabled } from "@/lib/tasks/types";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const ownerId = await owner(request);
    const graph = await getGraph(ownerId, {
      limit: Number(params.get("limit") || 60),
      offset: Number(params.get("offset") || 0),
      type: params.get("type") || undefined,
    });
    // `?tasks=1` adds the open-task layer for the returned pages as a separate
    // list; tasks never appear among the nodes or count toward `total`.
    if (
      !tasksEnabled() ||
      !parseTaskOverlayParam(params.get("tasks") ?? undefined)
    )
      return json(graph);
    return json({
      ...graph,
      taskOverlay: await loadTaskOverlay(
        ownerId,
        graph.nodes.map((node) => node.id),
      ),
    });
  } catch (error) {
    return failure(error);
  }
}
