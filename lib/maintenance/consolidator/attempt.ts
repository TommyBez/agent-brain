import { failureDiagnostic } from "./diagnostics";
import type {
  DecisionRecord,
  OperationPlan,
  RunHalt,
  RunnerSteps,
} from "./types";

type AttemptOutcome = {
  decision?: DecisionRecord;
  halt?: RunHalt["halt"];
  repair?: string[];
  changed: string[];
  writes: number;
  deferred: boolean;
  errors: number;
  capacity: number;
  failure?: { stage: string; diagnostic: ReturnType<typeof failureDiagnostic> };
};
export async function attempt(
  steps: RunnerSteps,
  snapshotId: string,
  plan: OperationPlan,
  index: number,
  repairs: number,
  feedback?: string[],
): Promise<AttemptOutcome> {
  const outcome: AttemptOutcome = {
    changed: [],
    writes: 0,
    deferred: false,
    errors: 0,
    capacity: 0,
  };
  let stage = "draft";
  try {
    const draft = await steps.draft(snapshotId, plan, index, feedback);
    if ("halt" in draft) return { ...outcome, halt: draft.halt };
    if ("capacity" in draft)
      return {
        ...outcome,
        capacity: 1,
        decision: {
          operationId: plan.id,
          status: "uncertain",
          reason: "capacity",
        },
      };
    if (draft.noChange)
      return {
        ...outcome,
        decision: { operationId: plan.id, status: "no_change" },
      };
    stage = "verification";
    const reviewed = await steps.review(snapshotId, plan, draft);
    if ("halt" in reviewed) return { ...outcome, halt: reviewed.halt };
    const verification = reviewed.verification;
    if (verification.incomplete)
      return { ...outcome, errors: 1, deferred: true };
    if (verification.status === "accepted" && reviewed.changeSet) {
      stage = "apply";
      outcome.changed = [...plan.targetPageIds];
      const applied = await steps.apply(reviewed.changeSet);
      if (applied.status === "conflict")
        return {
          ...outcome,
          changed: [...outcome.changed, ...applied.pageIds],
          deferred: true,
          decision: { operationId: plan.id, status: "conflict" },
        };
      return {
        ...outcome,
        writes: applied.pages.length,
        deferred: true,
        decision: {
          operationId: plan.id,
          status: "applied",
          changeSet: reviewed.changeSet,
          verification,
        },
      };
    }
    if (verification.status === "rejected" && index < repairs)
      return { ...outcome, repair: verification.defects };
    return {
      ...outcome,
      capacity: verification.capacity ? 1 : 0,
      decision: {
        operationId: plan.id,
        status: verification.status === "rejected" ? "rejected" : "uncertain",
        verification,
        ...(verification.capacity ? { reason: "capacity" } : {}),
      },
    };
  } catch (error) {
    return {
      ...outcome,
      errors: 1,
      deferred: true,
      failure: { stage, diagnostic: failureDiagnostic(error) },
    };
  }
}
