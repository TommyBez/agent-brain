import { transaction } from "../db";
import type { Actor } from "./actors";
import { taskError } from "./errors";
import { recordEvent } from "./events";
import { assertOwnerActor } from "./mutations";
import { lockTask } from "./records";

// "A blocks B": B (task) depends on A (dependsOn). The queue never offers a
// task with an unfinished dependency; tasks explicitly blocked on dependencies
// return to ready when the last one is done.

/** Adds a dependency, refusing cycles under a per-owner advisory lock. */
export async function addTaskDependency(
  actor: Actor,
  taskRef: string,
  dependsOnRef: string,
) {
  assertOwnerActor(actor);
  const ownerId = actor.ownerId;
  return transaction(async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext('task-dependencies'))",
      [ownerId],
    );
    const task = await lockTask(db, ownerId, taskRef);
    const blocker = await lockTask(db, ownerId, dependsOnRef);
    if (task.id === blocker.id)
      throw taskError(
        "DEPENDENCY_CYCLE",
        "A task cannot depend on itself.",
        "Choose a different task.",
      );
    const { rows } = await db.query(
      `WITH RECURSIVE reach(id) AS (
         SELECT $2::uuid
         UNION
         SELECT d.depends_on_task_id FROM brain_task_dependencies d
         JOIN reach r ON d.task_id = r.id WHERE d.owner_id = $1
       ) SELECT EXISTS (SELECT 1 FROM reach WHERE id = $3) AS cycle`,
      [ownerId, blocker.id, task.id],
    );
    if (rows[0].cycle)
      throw taskError(
        "DEPENDENCY_CYCLE",
        `${blocker.ref} already depends on ${task.ref}, directly or indirectly.`,
        "Remove the opposite dependency first, or choose another task.",
        { ref: task.ref, dependsOn: blocker.ref },
      );
    const inserted = await db.query(
      `INSERT INTO brain_task_dependencies (owner_id, task_id, depends_on_task_id, created_by_agent_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [ownerId, task.id, blocker.id, actor.agentId],
    );
    if (inserted.rowCount)
      await recordEvent(db, {
        ownerId,
        taskId: task.id,
        actorAgentId: actor.agentId,
        action: "edited",
        payload: {
          changedFields: ["dependencies"],
          dependsOn: { added: blocker.ref },
        },
      });
    return {
      ref: task.ref,
      dependsOn: blocker.ref,
      added: Boolean(inserted.rowCount),
    };
  });
}

export async function removeTaskDependency(
  actor: Actor,
  taskRef: string,
  dependsOnRef: string,
) {
  assertOwnerActor(actor);
  const ownerId = actor.ownerId;
  return transaction(async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext('task-dependencies'))",
      [ownerId],
    );
    const task = await lockTask(db, ownerId, taskRef);
    const blocker = await lockTask(db, ownerId, dependsOnRef);
    const removed = await db.query(
      "DELETE FROM brain_task_dependencies WHERE owner_id = $1 AND task_id = $2 AND depends_on_task_id = $3",
      [ownerId, task.id, blocker.id],
    );
    if (removed.rowCount)
      await recordEvent(db, {
        ownerId,
        taskId: task.id,
        actorAgentId: actor.agentId,
        action: "edited",
        payload: {
          changedFields: ["dependencies"],
          dependsOn: { removed: blocker.ref },
        },
      });
    return {
      ref: task.ref,
      dependsOn: blocker.ref,
      removed: Boolean(removed.rowCount),
    };
  });
}
