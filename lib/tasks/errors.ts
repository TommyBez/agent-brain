import type { z } from "zod";
import { BrainError } from "../brain/types";

export type TaskErrorCode =
  | "INVALID_INPUT"
  | "TASK_NOT_FOUND"
  | "PROJECT_NOT_FOUND"
  | "PAGE_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "SUGGESTION_NOT_FOUND"
  | "LINK_NOT_FOUND"
  | "PARTY_NOT_FOUND"
  | "NOT_ALLOWED"
  | "NOT_TASK_HOLDER"
  | "LEASE_LOST"
  | "LEASE_HELD"
  | "NOT_CLAIMABLE"
  | "CLAIM_ON_REQUEST_DISABLED"
  | "NO_CLAIMABLE_TASK"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "EXTRACTION_REJECTED"
  | "RATE_LIMITED"
  | "TASK_VERSION_CONFLICT"
  | "INVALID_TRANSITION"
  | "OUTPUT_REQUIRED"
  | "REPORT_INCOMPLETE"
  | "ALREADY_COMPLETED"
  | "DEPENDENCY_CYCLE"
  | "INVALID_RRULE"
  | "RECURRENCE_NOT_FOUND";

const STATUS: Record<TaskErrorCode, number> = {
  INVALID_INPUT: 400,
  TASK_NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  PAGE_NOT_FOUND: 404,
  AGENT_NOT_FOUND: 404,
  SUGGESTION_NOT_FOUND: 404,
  LINK_NOT_FOUND: 404,
  PARTY_NOT_FOUND: 404,
  NOT_ALLOWED: 403,
  NOT_TASK_HOLDER: 403,
  LEASE_LOST: 409,
  LEASE_HELD: 409,
  NOT_CLAIMABLE: 409,
  CLAIM_ON_REQUEST_DISABLED: 403,
  NO_CLAIMABLE_TASK: 404,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  EXTRACTION_REJECTED: 409,
  RATE_LIMITED: 429,
  TASK_VERSION_CONFLICT: 409,
  INVALID_TRANSITION: 409,
  OUTPUT_REQUIRED: 422,
  REPORT_INCOMPLETE: 422,
  ALREADY_COMPLETED: 409,
  DEPENDENCY_CYCLE: 409,
  INVALID_RRULE: 400,
  RECURRENCE_NOT_FOUND: 404,
};

/**
 * Every task error carries `details.remedy`: the protocol travels in results
 * because clients truncate server instructions.
 */
export function taskError(
  code: TaskErrorCode,
  message: string,
  remedy: string,
  details: Record<string, unknown> = {},
): BrainError {
  return new BrainError(code, message, STATUS[code], { ...details, remedy });
}

export function parseTaskInput<T extends z.ZodType>(
  schema: T,
  input: unknown,
): z.output<T> {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  throw taskError(
    "INVALID_INPUT",
    "The task request is invalid.",
    "Fix the listed fields and retry; values are checked after removing invisible and control characters.",
    {
      issues: parsed.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    },
  );
}

export function taskNotFound(ref: string): BrainError {
  return taskError(
    "TASK_NOT_FOUND",
    `Task ${ref} was not found.`,
    "Use a reference such as T-42 or a task id from list_tasks.",
    { ref },
  );
}
