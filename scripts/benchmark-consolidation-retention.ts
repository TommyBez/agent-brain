import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getPool } from "../lib/db";
import {
  prepareConsolidationRetention,
  pruneConsolidationBatch,
} from "../lib/maintenance/consolidator/retention";

// Deliberately no .env loader. Synthetic data only, on a disposable local DB.
const url = process.env.BRAIN_TEST_DATABASE_URL;
if (
  !url ||
  !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)
) {
  throw new Error("A loopback BRAIN_TEST_DATABASE_URL is required");
}
process.env.DATABASE_URL = url;
const pool = getPool();
const owner = `retention-benchmark-${randomUUID()}`;
const runId = "benchmark";
async function main() {
  try {
    // 26k distinct analysis keys, 24k still retained. Incompressible-ish,
    // deterministic synthetic text: 375 md5 hashes = 12,000 bytes per analysis.
    await pool.query(
      `INSERT INTO brain_consolidation_records
      SELECT $1,'seed','record','analysis:'||n,
        jsonb_build_object('status','complete','findings','[]'::jsonb,'judgments',jsonb_build_array(
          jsonb_build_object('state',jsonb_build_object('text',
            (SELECT string_agg(md5(n::text||':'||i::text),'') FROM generate_series(1,375) i)),
            'questions',jsonb_build_object('objective',jsonb_build_object('type','boolean','instructions','Synthetic check')),
            'answers',jsonb_build_object('objective',jsonb_build_object('type','boolean','probability',0.2))))),
        now()-CASE WHEN n<=24000 THEN interval '20 days' ELSE interval '70 days' END
      FROM generate_series(1,26000) n`,
      [owner],
    );
    await pool.query(
      `INSERT INTO brain_consolidation_records
      SELECT $1,'seed','record','evaluation:'||n,
        '{"answers":{"objective":{"type":"boolean","probability":0.2}},"model":"synthetic","inputTokens":3000,"outputTokens":1}'::jsonb,
        now()-interval '70 days' FROM generate_series(1,10000) n`,
      [owner],
    );
    await pool.query(
      `INSERT INTO brain_consolidation_records
      SELECT $1,'seed','record','decision:'||n,'{"status":"accepted"}'::jsonb,now()-interval '20 days'
      FROM generate_series(1,2000) n`,
      [owner],
    );
    await pool.query(
      `INSERT INTO brain_consolidation_records
      SELECT $1,'old-run-'||n,'record','snapshot:synthetic','{}'::jsonb,now()-interval '20 days'
      FROM generate_series(1,2000) n`,
      [owner],
    );
    await pool.query("ANALYZE brain_consolidation_records");
    const before = (
      await pool.query(
        `SELECT count(*)::int AS rows,
      pg_total_relation_size('brain_consolidation_records')::float8/1024/1024 AS table_mib,
      (SELECT avg(octet_length(payload::text))::float8 FROM brain_consolidation_records WHERE owner_id=$1 AND record_key LIKE 'analysis:%') AS analysis_bytes
      FROM brain_consolidation_records WHERE owner_id=$1`,
        [owner],
      )
    ).rows[0];
    const start = performance.now();
    const plan = await prepareConsolidationRetention(owner, runId);
    const planningMs = performance.now() - start;
    const batchMs: number[] = [];
    let deleted = 0;
    for (let batch = 0; batch < plan.batches; batch++) {
      const started = performance.now();
      deleted += await pruneConsolidationBatch(owner, runId, batch);
      batchMs.push(performance.now() - started);
    }
    const after = (
      await pool.query(
        `SELECT count(*)::int AS rows FROM brain_consolidation_records WHERE owner_id=$1 AND record_key NOT LIKE 'retention:%'`,
        [owner],
      )
    ).rows[0].rows;
    assert.equal(before.rows, 40000);
    assert.equal(deleted, 4000);
    assert.equal(after, 36000);
    const retryStart = performance.now();
    assert.deepEqual(await prepareConsolidationRetention(owner, runId), plan);
    const replayPlanningMs = performance.now() - retryStart;
    console.log(
      JSON.stringify(
        {
          before,
          after,
          deleted,
          batches: plan.batches,
          planningMs,
          batchMs,
          maxBatchMs: Math.max(...batchMs),
          replayPlanningMs,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.query(
      "DELETE FROM brain_consolidation_records WHERE owner_id=$1",
      [owner],
    );
    await pool.end();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
