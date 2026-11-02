import type { Database } from "../brain/pages";

const TASK_RULES_VERSION = "task-rules-v1";
interface RuleCandidate {
  pageId: string;
  role: "decision";
  origin: "rule";
  status: "suggested";
  confidence: null;
  evidence: Record<string, unknown>;
}
/** Read-only project decision candidates, never persisted. */
export async function desiredRuleLinks(
  db: Database,
  ownerId: string,
  task: { projectPageId: string | null },
): Promise<RuleCandidate[]> {
  const writes: RuleCandidate[] = [];
  if (task.projectPageId) {
    // Decisions decided_in the project are suggestions: a project can hold
    // many decisions and not all of them govern this task.
    const { rows } = await db.query(
      `SELECT DISTINCT d.id, d.version FROM brain_links l
       JOIN brain_pages d ON d.owner_id = l.owner_id AND d.id = l.source_id
       WHERE l.owner_id = $1 AND l.target_id = $2 AND l.type = 'decided_in' AND d.type = 'decision'
       ORDER BY d.id`,
      [ownerId, task.projectPageId],
    );
    for (const row of rows)
      writes.push({
        pageId: row.id,
        role: "decision",
        origin: "rule",
        status: "suggested",
        confidence: null,
        evidence: {
          basis: "decided_in",
          policyVersion: TASK_RULES_VERSION,
          pageVersion: row.version,
          projectId: task.projectPageId,
        },
      });
  }
  return writes;
}
