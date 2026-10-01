import { LINK_TYPES } from "../../brain/types";
import type { OperationPlan, Snapshot } from "./types";
export function invalid(reason: string): never {
  throw new Error(`Invalid consolidation draft: ${reason}`);
}

export function validatePlan(snapshot: Snapshot, plan: OperationPlan) {
  const pages = new Map(snapshot.pages.map((page) => [page.id, page]));
  const units = new Map(snapshot.units.map((unit) => [unit.id, unit]));
  if (
    pages.size !== snapshot.pages.length ||
    units.size !== snapshot.units.length
  ) {
    invalid("ambiguous snapshot identifiers");
  }
  const reads = new Map(plan.readSet.map((ref) => [ref.pageId, ref.version]));
  if (
    reads.size !== plan.readSet.length ||
    !plan.targetPageIds.length ||
    new Set(plan.targetPageIds).size !== plan.targetPageIds.length ||
    new Set(plan.targetUnitIds).size !== plan.targetUnitIds.length
  ) {
    invalid("ambiguous or empty plan");
  }
  for (const ref of plan.readSet) {
    if (pages.get(ref.pageId)?.version !== ref.version)
      invalid("stale read set");
  }
  for (const id of plan.targetPageIds) {
    if (!reads.has(id)) invalid("target outside the read set");
  }
  for (const id of [...plan.targetUnitIds, ...plan.evidenceUnitIds]) {
    const unit = units.get(id);
    const page = unit && pages.get(unit.pageId);
    if (
      !unit ||
      !page ||
      !reads.has(page.id) ||
      unit.start < 0 ||
      unit.end <= unit.start ||
      page.markdown.slice(unit.start, unit.end) !== unit.text
    ) {
      invalid("unknown or stale evidence unit");
    }
  }
  for (const id of plan.targetUnitIds) {
    if (!plan.targetPageIds.includes(units.get(id)?.pageId ?? "")) {
      invalid("unit outside target pages");
    }
  }
  if (
    plan.retainedUnitId &&
    (!["deduplicate", "centralize"].includes(plan.kind) ||
      !plan.targetUnitIds.includes(plan.retainedUnitId))
  )
    invalid("retained unit outside deduplication or centralization scope");
  if (
    plan.correctionUnitIds?.some(
      (id) => plan.kind !== "reconcile" || !plan.targetUnitIds.includes(id),
    ) ||
    (plan.correctionUnitIds?.length && !plan.evidenceUnitIds.length)
  ) {
    invalid("unbounded correction exception");
  }
  if (
    plan.kind === "centralize" &&
    (!plan.canonicalPageId ||
      !plan.targetPageIds.includes(plan.canonicalPageId))
  ) {
    invalid("missing centralization destination");
  }
  if (plan.link) {
    if (
      plan.kind !== "add_link" ||
      !plan.targetPageIds.includes(plan.link.sourceId) ||
      !reads.has(plan.link.targetId) ||
      plan.link.sourceId === plan.link.targetId ||
      !LINK_TYPES.includes(plan.link.type)
    ) {
      invalid("link outside plan scope");
    }
  } else if (plan.kind === "add_link") {
    invalid("missing planned link");
  }
  return { pages, units };
}
