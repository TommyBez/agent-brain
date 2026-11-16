import { assertOwner } from "../../brain/utils";
import { transaction } from "../../db";

const BATCH_SIZE = 500;
const PLAN_KEY = "retention:plan";
const batchKey = (batch: number) => `retention:batch:${batch}`;
type Plan = { batches: number; candidates: number };

/** Read legacy payloads once, then persist only candidate identities in the
 * existing operational table. Atomic plan + summary survive Workflow retries.
 * No schema change. Each statement has a 10s timeout and lock waits cap at 1s.
 */
export async function prepareConsolidationRetention(
  ownerId: string,
  runId: string,
): Promise<Plan> {
  "use step";
  assertOwner(ownerId);
  return transaction(async (db) => {
    await db.query("SET LOCAL statement_timeout='10s'");
    await db.query("SET LOCAL lock_timeout='1s'");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [
      ownerId,
      `retention:${runId}`,
    ]);
    const previous = await db.query<{ payload: Plan }>(
      `SELECT payload FROM brain_consolidation_records WHERE owner_id=$1 AND run_id=$2 AND kind='record' AND record_key=$3`,
      [ownerId, runId, PLAN_KEY],
    );
    if (previous.rows[0]) return previous.rows[0].payload;
    const result = await db.query<{ candidates: number }>(
      `WITH latest AS MATERIALIZED (
         SELECT DISTINCT ON (record_key) run_id,record_key
         FROM brain_consolidation_records
         WHERE owner_id=$1 AND kind='record'
           AND record_key ~ '^(analysis:|evaluation:|decision:|task-keeper:)'
           AND created_at > now() - interval '60 days'
         ORDER BY record_key,created_at DESC,run_id DESC
       ), dependencies AS MATERIALIZED (
         SELECT j->>'evaluationKey' AS key, j ? 'state' OR j ? 'questions' AS legacy
         FROM brain_consolidation_records r
         LEFT JOIN latest l ON l.run_id=r.run_id AND l.record_key=r.record_key
         CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.payload->'judgments','[]'::jsonb)) j
         WHERE r.owner_id=$1 AND r.kind='record' AND r.record_key LIKE 'analysis:%'
           AND (r.created_at > now() - interval '14 days' OR l.run_id IS NOT NULL)
       ), legacy AS MATERIALIZED (
         SELECT coalesce(bool_or(legacy),false) AS protect_evaluations FROM dependencies
       ), protected AS MATERIALIZED (
         SELECT run_id,record_key FROM latest
         UNION
         SELECT r.run_id,r.record_key FROM brain_consolidation_records r
         JOIN (SELECT DISTINCT key FROM dependencies WHERE key IS NOT NULL) d ON d.key=r.record_key
         WHERE r.owner_id=$1 AND r.kind='record'
       ), candidates AS (
         SELECT r.run_id,r.record_key,r.created_at,
           (row_number() OVER (ORDER BY r.created_at,r.run_id,r.record_key)-1)/$3::int AS batch
         FROM brain_consolidation_records r
         LEFT JOIN protected p ON p.run_id=r.run_id AND p.record_key=r.record_key
         CROSS JOIN legacy
         WHERE r.owner_id=$1 AND r.kind='record'
           AND r.created_at <= now() - interval '14 days' AND p.run_id IS NULL
           AND (NOT legacy.protect_evaluations OR r.record_key NOT LIKE 'evaluation:%')
       )
       INSERT INTO brain_consolidation_records(owner_id,run_id,kind,record_key,payload)
       SELECT $1,$2,'record','retention:batch:'||batch,
         jsonb_build_object('rows',jsonb_agg(jsonb_build_object(
           'run_id',run_id,'record_key',record_key,'created_at',created_at)))
       FROM candidates GROUP BY batch
       RETURNING jsonb_array_length(payload->'rows') AS candidates`,
      [ownerId, runId, BATCH_SIZE],
    );
    const plan = {
      batches: result.rows.length,
      candidates: result.rows.reduce((n, r) => n + r.candidates, 0),
    };
    await db.query(
      `INSERT INTO brain_consolidation_records(owner_id,run_id,kind,record_key,payload) VALUES ($1,$2,'record',$3,$4::jsonb)`,
      [ownerId, runId, PLAN_KEY, JSON.stringify(plan)],
    );
    return plan;
  });
}

/** Exactly one bounded batch per step. No legacy payload reads, no dependency
 * computation, and primary-key deletes only. Persist the result atomically so a
 * retry after commit reports the same count and never repeats its deletions.
 */
export async function pruneConsolidationBatch(
  ownerId: string,
  runId: string,
  batch: number,
) {
  "use step";
  assertOwner(ownerId);
  return transaction(async (db) => {
    await db.query("SET LOCAL statement_timeout='5s'");
    await db.query("SET LOCAL lock_timeout='1s'");
    const plan = await db.query<{
      payload: { rows?: unknown[]; deleted?: number };
    }>(
      `SELECT payload FROM brain_consolidation_records WHERE owner_id=$1 AND run_id=$2 AND kind='record' AND record_key=$3 FOR UPDATE`,
      [ownerId, runId, batchKey(batch)],
    );
    if (!plan.rows[0]) throw new Error("Retention batch is unavailable");
    if (plan.rows[0].payload.deleted !== undefined)
      return plan.rows[0].payload.deleted;
    const result = await db.query(
      `DELETE FROM brain_consolidation_records r
       USING jsonb_to_recordset($2::jsonb) AS v(run_id text,record_key text,created_at timestamptz)
       WHERE r.owner_id=$1 AND r.kind='record' AND r.run_id=v.run_id
         AND r.record_key=v.record_key AND r.created_at=v.created_at`,
      [ownerId, JSON.stringify(plan.rows[0].payload.rows)],
    );
    const deleted = result.rowCount ?? 0;
    await db.query(
      `UPDATE brain_consolidation_records SET payload=$4::jsonb WHERE owner_id=$1 AND run_id=$2 AND kind='record' AND record_key=$3`,
      [ownerId, runId, batchKey(batch), JSON.stringify({ deleted })],
    );
    return deleted;
  });
}

export async function recordRetentionOutcome(
  ownerId: string,
  runId: string,
  outcome: Record<string, unknown>,
) {
  "use step";
  assertOwner(ownerId);
  await transaction(async (db) => {
    await db.query("SET LOCAL statement_timeout='5s'");
    await db.query("SET LOCAL lock_timeout='1s'");
    await db.query(
      `INSERT INTO brain_consolidation_records(owner_id,run_id,kind,record_key,payload)
    VALUES ($1,$2,'record','retention:outcome',$3::jsonb)
    ON CONFLICT (owner_id,run_id,kind,record_key) DO UPDATE SET payload=EXCLUDED.payload`,
      [ownerId, runId, JSON.stringify(outcome)],
    );
  });
}
