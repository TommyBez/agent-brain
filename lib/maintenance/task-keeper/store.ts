import type { Database } from "../../brain/pages";
import { assertOwner } from "../../brain/utils";
import { getPool } from "../../db";
import type { TaskSuggestionKind } from "../../tasks/types";
import { TASK_KEEPER_LIMITS } from "./policy";
import { TASK_KEEPER_POLICY } from "./prompts";

// Records live in brain_consolidation_records with the `task-keeper:` prefix
// (§5.1); Jev answers stay in the shared `evaluation:` cache.
export const keeperKeys = {
  /** The page as read in this run (exact passages and linked pages). */
  snapshot: (unitId: string) => `task-keeper:snapshot:${unitId}` as const,
  /** The page was fully processed under this policy and evidence. */
  page: (unitId: string) => `task-keeper:page:${unitId}` as const,
  extraction: (key: string) => `task-keeper:extraction:${key}` as const,
  hygiene: (unitId: string) => `task-keeper:hygiene:${unitId}` as const,
  duplicate: (unitId: string) => `task-keeper:duplicate:${unitId}` as const,
  /** The page waits for a free suggestion slot on an existing task. */
  capped: (unitId: string) => `task-keeper:capped:${unitId}` as const,
  /** The page exceeds Jev's request limit `limit`: left pending and reported. */
  oversized: (unitId: string, limit: number) =>
    `task-keeper:oversized:${limit}:${unitId}` as const,
  /** A passage cited by the extraction with this fingerprint (text-free). */
  identity: (passage: string, extraction: string) =>
    `task-keeper:identity:${passage}:${extraction}` as const,
};

/** Pages the owner excluded from the task keeper (confidential material). */
export async function keeperExcludedPageIds(
  ownerId: string,
): Promise<string[]> {
  assertOwner(ownerId);
  const { rows } = await getPool().query(
    "SELECT keeper_excluded_page_ids FROM brain_task_settings WHERE owner_id = $1",
    [ownerId],
  );
  return rows[0]?.keeper_excluded_page_ids ?? [];
}

export interface SuggestionCitation {
  pageId?: string;
  slug?: string;
  title?: string;
  pageVersion?: number;
  startOffset?: number;
  endOffset?: number;
  excerpt?: string;
  taskId?: string;
  ref?: string;
}

export interface SuggestionInput {
  ownerId: string;
  taskId: string;
  relatedTaskId?: string | null;
  kind: TaskSuggestionKind;
  citations: SuggestionCitation[];
  confidence?: number | null;
  dedupeKey: string;
  /** The prefilled transition the owner executes on acceptance. */
  payload: Record<string, unknown>;
  createdByAgentId: string;
}

export type SuggestionOutcome = "opened" | "exists" | "capped";

/**
 * Opens a suggestion unless its dedupe key exists in any state (a dismissed
 * suggestion never returns) or the task already has three open ones. A
 * `capped` proposal is stored nowhere: callers keep their unit pending and
 * propose it again on a later run. The nightly owner lock serializes writers.
 */
export async function openSuggestion(
  db: Database,
  input: SuggestionInput,
): Promise<SuggestionOutcome> {
  // The outer query reads the snapshot before the insert: `existing` means
  // the key was already there.
  const { rows } = await db.query(
    `WITH inserted AS (
       INSERT INTO brain_task_suggestions (owner_id, task_id, related_task_id, kind, citations,
         confidence, policy_version, dedupe_key, payload, created_by_agent_id)
       SELECT $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb, $10
       WHERE (SELECT count(*) FROM brain_task_suggestions
              WHERE owner_id = $1 AND task_id = $2 AND status = 'open') < $11
       ON CONFLICT (owner_id, dedupe_key) DO NOTHING
       RETURNING 1
     )
     SELECT EXISTS (SELECT 1 FROM inserted) AS opened,
       EXISTS (SELECT 1 FROM brain_task_suggestions
               WHERE owner_id = $1 AND dedupe_key = $8) AS existing`,
    [
      input.ownerId,
      input.taskId,
      input.relatedTaskId ?? null,
      input.kind,
      JSON.stringify(input.citations),
      input.confidence ?? null,
      TASK_KEEPER_POLICY.version,
      input.dedupeKey.slice(0, 256),
      JSON.stringify(input.payload),
      input.createdByAgentId,
      TASK_KEEPER_LIMITS.openSuggestionsPerTask,
    ],
  );
  return rows[0].opened ? "opened" : rows[0].existing ? "exists" : "capped";
}

/** Tasks without a free suggestion slot; work for them goes last. */
export async function tasksAtSuggestionCap(
  ownerId: string,
): Promise<Set<string>> {
  const { rows } = await getPool().query(
    `SELECT task_id FROM brain_task_suggestions
     WHERE owner_id = $1 AND status = 'open'
     GROUP BY task_id HAVING count(*) >= $2`,
    [ownerId, TASK_KEEPER_LIMITS.openSuggestionsPerTask],
  );
  return new Set(rows.map((row) => row.task_id as string));
}
