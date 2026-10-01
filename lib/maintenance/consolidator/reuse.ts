import { recordKeys } from "./keys";
import { selectIndependentPlans } from "./planner";
import { pageEvidenceFingerprint } from "./snapshot";
import type {
  AnalysisResult,
  DecisionRecord,
  OperationPlan,
  Snapshot,
} from "./types";

export function canReuseAnalysis(
  snapshot: Snapshot,
  result: Pick<AnalysisResult, "status" | "dependencies"> | undefined,
): boolean {
  return (
    result?.status === "complete" &&
    (result.dependencies ?? []).every((ref) => {
      const page = snapshot.pages.find(
        (page) => page.id === ref.pageId || page.slug === ref.pageId,
      );
      return (page ? pageEvidenceFingerprint(page) : null) === ref.fingerprint;
    })
  );
}

export function canReuseDecision(
  snapshot: Snapshot,
  decision: DecisionRecord | undefined,
): boolean {
  return Boolean(
    decision &&
      ["rejected", "uncertain", "no_change"].includes(decision.status) &&
      decision.evidenceFingerprints?.every((ref) => {
        const page = snapshot.pages.find((page) => page.id === ref.pageId);
        return (
          page !== undefined &&
          pageEvidenceFingerprint(page) === ref.fingerprint
        );
      }),
  );
}

export function unreusedPlans(
  snapshot: Snapshot,
  plans: OperationPlan[],
  decisions: ReadonlyMap<string, DecisionRecord>,
) {
  const remaining: OperationPlan[] = [];
  let capacityLimited = 0;
  for (const plan of plans) {
    const decision = decisions.get(recordKeys.decision(plan.id));
    if (!canReuseDecision(snapshot, decision)) remaining.push(plan);
    else if (decision?.reason === "capacity") capacityLimited++;
  }
  const selected = selectIndependentPlans(remaining);
  return {
    selected: selected.selected,
    deferred: selected.deferred.length,
    capacityLimited,
  };
}
