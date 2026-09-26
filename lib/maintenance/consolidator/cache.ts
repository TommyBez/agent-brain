import type { AnalysisResult, DecisionRecord, Snapshot } from "./types";

export function canReuseAnalysis(
  snapshotId: string,
  result: Pick<AnalysisResult, "status" | "corpusSnapshotId"> | undefined,
): boolean {
  return (
    result?.status === "complete" &&
    (!result.corpusSnapshotId || result.corpusSnapshotId === snapshotId)
  );
}

export function canReuseDecision(
  snapshot: Snapshot,
  decision: DecisionRecord | undefined,
): boolean {
  return Boolean(
    decision &&
      ["rejected", "uncertain", "no_change"].includes(decision.status) &&
      decision.evidenceVersions?.every(
        (ref) =>
          snapshot.pages.find((page) => page.id === ref.pageId)?.version ===
          ref.version,
      ),
  );
}
