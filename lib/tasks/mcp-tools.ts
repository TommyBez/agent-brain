import type { Principal } from "../auth-principal";
import type { Actor } from "./actors";
import { resolveActor } from "./actors";
import { claimTask, completeTask, releaseTask, reportTask } from "./claims";
import { createTask, listTasks, readTask, updateTask } from "./service";
import {
  TASK_TOOL_DEFINITIONS,
  type TaskToolDefinition,
  type TaskToolName,
} from "./tool-definitions";

type TaskOperation = (actor: Actor, input: unknown) => Promise<unknown>;

const OPERATIONS: Record<TaskToolName, TaskOperation> = {
  list_tasks: listTasks,
  read_task: readTask,
  create_task: createTask,
  update_task: updateTask,
  claim_task: claimTask,
  report_task: reportTask,
  release_task: releaseTask,
  complete_task: completeTask,
};

export interface TaskTool extends TaskToolDefinition {
  /** Task tools only ever expire tasks:<owner>, never the knowledge cache. */
  invalidates: "none" | "tasks";
  handler: (
    ownerId: string,
    input: unknown,
    principal: Principal,
  ) => Promise<unknown>;
}

/** Each call resolves the calling agent from its credential first. */
export const TASK_TOOLS: TaskTool[] = TASK_TOOL_DEFINITIONS.map(
  (definition) => ({
    ...definition,
    invalidates: definition.annotations.readOnlyHint ? "none" : "tasks",
    handler: async (ownerId, input, principal) =>
      OPERATIONS[definition.name](
        await resolveActor(ownerId, principal),
        input,
      ),
  }),
);

export const TASK_TOOL_NAMES = new Set<string>(
  TASK_TOOL_DEFINITIONS.map((definition) => definition.name),
);
