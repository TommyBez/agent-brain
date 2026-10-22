import { transaction } from "../db";
import { systemActor } from "./actors";
import { lockTaskForLinks, refreshTaskRules } from "./links";
import { syncTaskRetrieval } from "./retrieval";

// Extension point for the conciliator (block C): deterministic rules
// (decided_in decisions of the project) and retrieval suggestions computed
// after a task's content commits. The service calls it after every create and
// content edit; failures never fail the task operation.

export interface DerivedLinkContext {
  ownerId: string;
  taskId: string;
  actorAgentId: string;
  trigger: "created" | "updated";
}

/** Rule and retrieval links are written by the conciliator, not the caller. */
export async function syncDerivedTaskLinks(
  context: DerivedLinkContext,
): Promise<void> {
  const conciliator = await systemActor(context.ownerId, "consolidator");
  await transaction(async (db) => {
    const task = await lockTaskForLinks(db, context.ownerId, context.taskId);
    if (task)
      await refreshTaskRules(db, context.ownerId, task, conciliator.agentId);
  });
  await syncTaskRetrieval(context.ownerId, context.taskId, conciliator.agentId);
}
