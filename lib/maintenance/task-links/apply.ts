import { transaction } from "../../db";
import {
  type ExistingTaskLink,
  existingTaskLinks,
  type LinkChange,
  lockTaskForLinks,
  type MachineLinkWrite,
  recordLinkChanges,
  summarizeChanges,
  writeMachineLinks,
} from "../../tasks/links";
import { taskSemanticFingerprint } from "../../tasks/retrieval";
import { type CandidateSource, taskLinkKeys } from "./candidates";
import type { AutoApplyState } from "./gate";
import { TASK_LINK_POLICY } from "./policy";
import {
  type LinkedRole,
  linkRole,
  type PageJudgment,
  roleScore,
} from "./questions";
import { hasReceipt, loadEvidencePages, saveReceipt } from "./store";

// §8.3 step 6: one transaction per task under the task-links advisory lock,
// compare-and-swap on the evaluated fingerprints, the §6.4 guard on every
// write, a links_changed event by the consolidator and an apply receipt that
// makes a Workflow replay harmless. The receipt is per run: a unit that comes
// back on a later night (an edit reverted) is planned again against the
// current rows, and planning an unchanged state writes nothing.

export interface AnalyzedCandidate {
  pageId: string;
  type: string;
  version: number;
  fingerprint: string;
  source: CandidateSource;
  startOffset: number;
  endOffset: number;
  judgment: PageJudgment;
}

/** Stored as `task-link:analysis:<unitId>`. */
export interface LinkAnalysis {
  unitId: string;
  policyVersion: string;
  taskId: string;
  taskFingerprint: string;
  evaluationKey: string | null;
  candidates: AnalyzedCandidate[];
}

const LINKED_ROLES: readonly string[] = ["context", "decision", "stakeholder"];
const round = (value: number) => Math.round(value * 1000) / 1000;
const live = (link: ExistingTaskLink) =>
  link.status === "suggested" || link.status === "active";

function evidenceFor(analysis: LinkAnalysis, candidate: AnalyzedCandidate) {
  return {
    basis: "jev",
    policyVersion: analysis.policyVersion,
    recordKey: taskLinkKeys.analysis(analysis.unitId),
    unitId: analysis.unitId,
    taskFingerprint: analysis.taskFingerprint,
    pageFingerprint: candidate.fingerprint,
    pageVersion: candidate.version,
    startOffset: candidate.startOffset,
    endOffset: candidate.endOffset,
    source: candidate.source,
    ...candidate.judgment,
  };
}

/** Whether the task or page changed since this consolidator link was evaluated. */
function fingerprintChanged(
  link: ExistingTaskLink,
  analysis: LinkAnalysis,
  candidate: AnalyzedCandidate,
): boolean {
  return (
    link.evidence.taskFingerprint !== analysis.taskFingerprint ||
    link.evidence.pageFingerprint !== candidate.fingerprint
  );
}

/**
 * Pure §8.3 apply policy.
 * - New links are suggestions unless the role's auto-apply gate is open
 *   (decision only in the project's decided_in neighbourhood).
 * - Consolidator links are retracted only after a fingerprint change and below
 *   0.50; the 0.50–0.80 band is left alone.
 * - An undecided retrieval suggestion is the conciliator's own guess: Jev
 *   upgrades it to a consolidator link when it confirms the context role, and
 *   supersedes it when it finds another role; otherwise it only adds its
 *   confidence, as on decided_in suggestions.
 * - Owner, agent, provenance, task keeper and rejected rows are never written,
 *   and a page never gets a second live role.
 */
export function planJevLinks(
  analysis: LinkAnalysis,
  existing: ExistingTaskLink[],
  autoApply: AutoApplyState,
): MachineLinkWrite[] {
  const writes: MachineLinkWrite[] = [];
  for (const candidate of analysis.candidates) {
    const target = linkRole(candidate.judgment);
    const rows = existing.filter((link) => link.pageId === candidate.pageId);
    const retracted = new Set<string>();
    let handled = false;
    const statusFor = (role: LinkedRole) =>
      autoApply[role] &&
      (role !== "decision" || candidate.source === "decided_in")
        ? "active"
        : "suggested";
    const linkFor = (
      role: LinkedRole,
      status: MachineLinkWrite["status"],
      extra: Record<string, unknown> = {},
    ): MachineLinkWrite => ({
      pageId: candidate.pageId,
      role,
      origin: "consolidator",
      status,
      confidence: round(roleScore(candidate.judgment, role)),
      evidence: { ...evidenceFor(analysis, candidate), ...extra },
    });
    for (const row of rows) {
      if (row.status === "rejected" || !LINKED_ROLES.includes(row.role))
        continue;
      const role = row.role as LinkedRole;
      if (row.origin === "consolidator") {
        if (target && role === target.role) {
          handled = true;
          writes.push(
            linkFor(
              role,
              row.status === "retracted" ? statusFor(role) : row.status,
              row.evidence.previousBasis
                ? { previousBasis: row.evidence.previousBasis }
                : {},
            ),
          );
        } else if (
          live(row) &&
          roleScore(candidate.judgment, role) < TASK_LINK_POLICY.retractBelow &&
          fingerprintChanged(row, analysis, candidate)
        ) {
          retracted.add(role);
          writes.push(
            linkFor(role, "retracted", { retractedBecause: "below_0.50" }),
          );
        }
        continue;
      }
      if (row.origin !== "rule" || !live(row) || row.decidedAt !== null)
        continue;
      if (row.evidence.basis === "retrieval" && target) {
        if (target.role === role) {
          handled = true;
          writes.push(
            linkFor(
              role,
              row.status === "active" ? "active" : statusFor(role),
              {
                previousBasis: "retrieval",
              },
            ),
          );
        } else {
          retracted.add(role);
          writes.push({
            pageId: row.pageId,
            role,
            origin: "rule",
            status: "retracted",
            confidence: round(roleScore(candidate.judgment, role)),
            evidence: {
              ...row.evidence,
              retractedBecause: "superseded_by_jev",
            },
          });
        }
        continue;
      }
      // decided_in suggestions, and retrieval ones Jev does not confirm.
      if (target?.role === role) handled = true;
      writes.push({
        pageId: row.pageId,
        role,
        origin: "rule",
        status: row.status as "suggested" | "active",
        confidence: round(roleScore(candidate.judgment, role)),
        evidence: row.evidence,
      });
    }
    if (!target || handled) continue;
    const same = rows.find((link) => link.role === target.role);
    const machineRetracted =
      same?.status === "retracted" &&
      (same.origin === "rule" || same.origin === "consolidator");
    if (same && !machineRetracted) continue;
    const otherLive = rows.some(
      (link) =>
        link.role !== target.role && live(link) && !retracted.has(link.role),
    );
    if (!otherLive) writes.push(linkFor(target.role, statusFor(target.role)));
  }
  return writes;
}

export type ApplyOutcome =
  | { status: "applied" | "replayed"; changes: LinkChange[] }
  | { status: "deferred"; reason: "task" | "pages"; changes: [] };

export async function applyLinkAnalysis(
  ownerId: string,
  agentId: string,
  analysis: LinkAnalysis,
  autoApply: AutoApplyState,
  runId: string,
): Promise<ApplyOutcome> {
  const receiptKey = taskLinkKeys.apply(analysis.unitId, runId);
  return transaction(async (db) => {
    const task = await lockTaskForLinks(db, ownerId, analysis.taskId);
    if (await hasReceipt(db, ownerId, receiptKey))
      return { status: "replayed", changes: [] };
    if (!task || taskSemanticFingerprint(task) !== analysis.taskFingerprint)
      return { status: "deferred", reason: "task", changes: [] };
    const pages = await loadEvidencePages(
      db,
      ownerId,
      analysis.candidates.map((candidate) => candidate.pageId),
    );
    if (
      analysis.candidates.some(
        (candidate) =>
          pages.get(candidate.pageId)?.fingerprint !== candidate.fingerprint,
      )
    )
      return { status: "deferred", reason: "pages", changes: [] };
    const existing = await existingTaskLinks(db, ownerId, analysis.taskId);
    const changes = await writeMachineLinks(
      db,
      ownerId,
      analysis.taskId,
      agentId,
      planJevLinks(analysis, existing, autoApply),
    );
    // Nothing written: a replay plans the same no-op, so no receipt is kept.
    if (!changes.length) return { status: "applied", changes };
    await recordLinkChanges(db, ownerId, analysis.taskId, agentId, changes, {
      basis: "jev",
      unitId: analysis.unitId,
      policyVersion: analysis.policyVersion,
    });
    const summary = summarizeChanges(changes);
    await saveReceipt(db, ownerId, receiptKey, {
      unitId: analysis.unitId,
      taskId: analysis.taskId,
      suggested: summary.suggested.length,
      activated: summary.activated.length,
      retracted: summary.retracted.length,
      updated: summary.updated.length,
    });
    return { status: "applied", changes };
  });
}
