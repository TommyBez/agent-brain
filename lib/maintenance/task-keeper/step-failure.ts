import { BudgetExhaustedError } from "../consolidator/budget";
import { failureDiagnostic } from "../consolidator/diagnostics";
import { GatewayRequestError } from "../gateway";
import { taskPhaseHalt } from "../task-phase-halt";

// Kept out of steps.ts: an exported plain function there stays in the
// Workflow bundle together with its Node-only imports.

export type StepStatus = {
  requests: number;
  halt: "budget" | "provider" | null;
  failed: boolean;
};

/** Classifies a step error: halt, page-level failure, or rethrow for a retry. */
export function stepFailure(error: unknown, requests: number): StepStatus {
  if (error instanceof BudgetExhaustedError)
    return { requests, halt: "budget", failed: false };
  if (error instanceof GatewayRequestError && error.status === 402)
    return { requests, halt: "provider", failed: false };
  if (taskPhaseHalt(error) === "provider") {
    console.error("task_keeper.provider_error", failureDiagnostic(error));
    return { requests, halt: null, failed: true };
  }
  throw error;
}
