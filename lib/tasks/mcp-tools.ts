import type { Principal } from "../auth-principal";
import { type GatewayCall, gatewayRequest } from "../maintenance/gateway";
import type { Actor } from "./actors";
import { assertTaskReader, resolveActor } from "./actors";
import { claimTask, completeTask, releaseTask, reportTask } from "./claims";
import { suggestTaskLinks } from "./link-candidates";
import { createTask, listTasks, readTask, updateTask } from "./service";
import {
  TASK_TOOL_DEFINITIONS,
  type TaskToolDefinition,
  type TaskToolName,
} from "./tool-definitions";

type TaskOperation = (actor: Actor, input: unknown) => Promise<unknown>;

const OPERATIONS: Record<
  Exclude<TaskToolName, "suggest_task_links">,
  TaskOperation
> = {
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

/** Suggestions authorize with reads only; write tools retain actor provisioning. */
export function createTaskTools(
  send: GatewayCall = gatewayRequest,
): TaskTool[] {
  return TASK_TOOL_DEFINITIONS.map((definition) => ({
    ...definition,
    invalidates: definition.annotations.readOnlyHint ? "none" : "tasks",
    handler: async (ownerId, input, principal) => {
      if (definition.name === "suggest_task_links") {
        await assertTaskReader(ownerId, principal);
        return suggestTaskLinks({ ownerId }, input, send);
      }
      return OPERATIONS[definition.name](
        await resolveActor(ownerId, principal),
        input,
      );
    },
  }));
}
export const TASK_TOOLS = createTaskTools();

export const TASK_TOOL_NAMES = new Set<string>(
  TASK_TOOL_DEFINITIONS.map((definition) => definition.name),
);
