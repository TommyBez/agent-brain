import { fingerprint, pageEvidenceFingerprint } from "./snapshot";
import {
  type AnalysisResult,
  type Finding,
  type OperationPlan,
  POLICY,
  type Snapshot,
} from "./types";

/** No speculative proposal may turn an uncertain semantic answer into a write. */
export function planOperations(
  snapshot: Snapshot,
  results: AnalysisResult[],
): OperationPlan[] {
  const pages = new Map(snapshot.pages.map((page) => [page.id, page]));
  const units = new Map(snapshot.units.map((unit) => [unit.id, unit]));
  const plans = new Map<string, OperationPlan>();
  for (const result of results) {
    for (const finding of result.findings) {
      if (finding.status !== "supported") continue;
      const selected = finding.unitIds.map((id) => units.get(id));
      const evidence = finding.evidenceUnitIds.map((id) => units.get(id));
      if (
        !selected.length ||
        selected.some((unit) => !unit) ||
        !evidence.length ||
        evidence.some((unit) => !unit)
      )
        continue;
      if (finding.pageIds.some((id) => !pages.has(id))) continue;
      if (
        finding.canonicalPageId &&
        !finding.pageIds.includes(finding.canonicalPageId)
      )
        continue;
      if (
        finding.retainedUnitId &&
        !finding.unitIds.includes(finding.retainedUnitId)
      )
        continue;
      if (finding.kind === "reconcile" && !finding.resolution) continue;
      if (finding.kind === "centralize" && !finding.canonicalPageId) continue;
      if (finding.kind === "add_link") {
        const edge = finding.link;
        if (
          !edge ||
          edge.sourceId === edge.targetId ||
          !pages.has(edge.sourceId) ||
          !pages.has(edge.targetId)
        )
          continue;
        if (
          pages
            .get(edge.sourceId)
            ?.links.some(
              (link) =>
                link.targetId === edge.targetId && link.type === edge.type,
            )
        )
          continue;
      }
      const targetPageIds =
        finding.kind === "add_link" && finding.link
          ? [finding.link.sourceId]
          : [
              ...new Set(
                selected.flatMap((unit) => (unit ? [unit.pageId] : [])),
              ),
            ];
      const readIds = new Set([
        ...finding.pageIds,
        ...targetPageIds,
        ...evidence.flatMap((unit) => (unit ? [unit.pageId] : [])),
        ...(finding.link ? [finding.link.targetId] : []),
      ]);
      const readPages = snapshot.pages.filter((page) => readIds.has(page.id));
      const readSet = readPages.map((page) => ({
        pageId: page.id,
        version: page.version,
      }));
      const shape = {
        kind: finding.kind,
        targetPageIds: targetPageIds.sort(),
        targetUnitIds: [...new Set(finding.unitIds)].filter(
          (id) =>
            finding.kind !== "add_link" ||
            units.get(id)?.pageId === finding.link?.sourceId,
        ),
        evidenceUnitIds: [...new Set(finding.evidenceUnitIds)].sort(),
        readSet,
        ...(finding.canonicalPageId
          ? { canonicalPageId: finding.canonicalPageId }
          : {}),
        ...(finding.retainedUnitId
          ? { retainedUnitId: finding.retainedUnitId }
          : {}),
        ...(finding.link ? { link: finding.link } : {}),
        ...(finding.resolution ? { resolution: finding.resolution } : {}),
        ...(finding.kind === "reconcile"
          ? { correctionUnitIds: correctionUnits(finding) }
          : {}),
        goal: finding.goal,
      };
      const id = fingerprint({
        policy: POLICY.version,
        pages: readPages.map(pageEvidenceFingerprint),
        ...(result.corpusSnapshotId
          ? { corpusSnapshotId: result.corpusSnapshotId }
          : {}),
        ...shape,
      });
      const existing = plans.get(id);
      if (existing) existing.findingIds.push(finding.id);
      else plans.set(id, { id, findingIds: [finding.id], ...shape });
    }
  }
  // Stable ordering keeps useful semantic work ahead of adding navigation edges.
  const rank = {
    reconcile: 0,
    centralize: 1,
    deduplicate: 2,
    remove_maintenance_residue: 3,
    add_link: 4,
  };
  return [...plans.values()].sort(
    (a, b) => rank[a.kind] - rank[b.kind] || a.id.localeCompare(b.id),
  );
}

function correctionUnits(finding: Finding): string[] {
  if (finding.resolution === "a") return finding.unitIds.slice(1);
  if (finding.resolution === "b") return finding.unitIds.slice(0, 1);
  return [...finding.unitIds];
}

/** Every edit depending on an edited evidence page is reanalysed next wave. */
export function selectIndependentPlans(plans: OperationPlan[]): {
  selected: OperationPlan[];
  deferred: OperationPlan[];
} {
  const selected: OperationPlan[] = [];
  const deferred: OperationPlan[] = [];
  const read = new Set<string>();
  const written = new Set<string>();
  for (const plan of plans) {
    if (
      plan.targetPageIds.some((id) => read.has(id)) ||
      plan.readSet.some(({ pageId }) => written.has(pageId))
    ) {
      deferred.push(plan);
      continue;
    }
    selected.push(plan);
    for (const { pageId } of plan.readSet) read.add(pageId);
    for (const id of plan.targetPageIds) written.add(id);
  }
  return { selected, deferred };
}
