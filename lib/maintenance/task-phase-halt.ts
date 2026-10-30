import { BudgetExhaustedError } from "./consolidator/budget";
import { EditorResponseError } from "./consolidator/diagnostics";
import { JevResponseError } from "./consolidator/jev";
import { GatewayRequestError } from "./gateway";
import type { TaskPhaseHalt } from "./task-phase";

/** Step-side: errors that end a task phase `partial` instead of `failed` (§8.2).
 * Classify inside the step and return the halt as data, like the consolidator's
 * RunHalt, rather than relying on error classes across the step boundary.
 */
export function taskPhaseHalt(error: unknown): TaskPhaseHalt | null {
  if (error instanceof BudgetExhaustedError) return "budget";
  if (
    error instanceof GatewayRequestError ||
    error instanceof JevResponseError ||
    error instanceof EditorResponseError
  )
    return "provider";
  return null;
}
