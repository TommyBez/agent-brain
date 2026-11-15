import { assertOwner } from "../../brain/utils";
import { getPool } from "../../db";

const BATCH_SIZE = 500;

/** One owner's operational records only. No DDL, VACUUM or Brain writes.
 * The latest cache expires at 60 days from creation; other records at 14 days.
 * Evaluation dependencies outlive their retained analyses, even beyond 60 days.
 */
export async function retainConsolidationRecords(ownerId: string) {
  "use step";
  assertOwner(ownerId);
  let deleted = 0;
  let batches = 0;
  // A fixed cutoff makes retries and all batches of this invocation consistent.
  const now = new Date().toISOString();
  while (true) {
    const result = await getPool().query(
      `WITH latest AS MATERIALIZED (
         SELECT DISTINCT ON (record_key) run_id,record_key
         FROM brain_consolidation_records
         WHERE owner_id=$1 AND kind='record'
           AND record_key ~ '^(analysis:|evaluation:|decision:|task-keeper:)'
           AND created_at > $2::timestamptz - interval '60 days'
         ORDER BY record_key,created_at DESC,run_id DESC
       ), kept_analysis AS MATERIALIZED (
         SELECT r.payload FROM brain_consolidation_records r
         WHERE r.owner_id=$1 AND r.kind='record' AND r.record_key LIKE 'analysis:%'
           AND (r.created_at > $2::timestamptz - interval '14 days'
             OR EXISTS (SELECT 1 FROM latest l WHERE l.run_id=r.run_id AND l.record_key=r.record_key))
       ), dependencies AS MATERIALIZED (
         SELECT j->>'evaluationKey' AS key,
           j ? 'state' OR j ? 'questions' AS legacy
         FROM kept_analysis a,
           jsonb_array_elements(coalesce(a.payload->'judgments','[]'::jsonb)) j
       ), victims AS (
         SELECT r.ctid FROM brain_consolidation_records r
         WHERE r.owner_id=$1 AND r.kind='record'
           AND r.created_at <= $2::timestamptz - interval '14 days'
           AND NOT EXISTS (SELECT 1 FROM latest l WHERE l.run_id=r.run_id AND l.record_key=r.record_key)
           AND NOT (r.record_key LIKE 'evaluation:%' AND EXISTS (
             SELECT 1 FROM dependencies d WHERE d.key=r.record_key OR d.legacy
           ))
         ORDER BY r.created_at,r.run_id,r.record_key
         LIMIT $3
       )
       DELETE FROM brain_consolidation_records r USING victims v WHERE r.ctid=v.ctid`,
      [ownerId, now, BATCH_SIZE],
    );
    const count = result.rowCount ?? 0;
    deleted += count;
    if (!count) break;
    batches++;
  }
  return { deleted, batches, recordWindowDays: 14, cacheWindowDays: 60 };
}
