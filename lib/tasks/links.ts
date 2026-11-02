import type { Database } from "../brain/pages";
import { TASK_LINK_CANDIDATE_POLICY } from "./link-candidate-policy";

/** Read bounded project decision ids; this module has no link-writing primitives. */
export async function readProjectDecisionPageIds(
  db: Database,
  ownerId: string,
  task: { projectPageId: string | null },
): Promise<string[]> {
  if (!task.projectPageId) return [];
  const { rows } = await db.query<{ id: string }>(
    `SELECT DISTINCT d.id FROM brain_links l JOIN brain_pages d ON d.owner_id = l.owner_id AND d.id = l.source_id
     WHERE l.owner_id = $1 AND l.target_id = $2 AND l.type = 'decided_in' AND d.type = 'decision'
     ORDER BY d.id LIMIT $3`,
    [
      ownerId,
      task.projectPageId,
      TASK_LINK_CANDIDATE_POLICY.maxDecisionCandidates,
    ],
  );
  return rows.map((row) => row.id);
}
