import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { search } from "../lib/brain/service";
import { embeddingModel } from "../lib/brain/utils";
import { getPool } from "../lib/db";

test(
  "filtered HNSW scans fill the semantic candidate pool without leaking settings",
  { skip: process.env.RUN_DB_TESTS !== "1" },
  async (t) => {
    const owner = `hnsw-test-${randomUUID()}`;
    const distractor = `hnsw-test-${randomUUID()}`;
    const vector = Array.from({ length: 1536 }, (_, index) =>
      index === 0 ? 1 : 0,
    );
    const db = await getPool().connect();
    let inTransaction = false;
    try {
      // More-nearby vectors belong to another owner; default ANN filtering exhausts
      // its initial candidate pool before it reaches this owner's eligible pages.
      for (const [scope, count, first, second] of [
        [owner, 70, 0.7, 0.4],
        [distractor, 110, 1, 0],
      ] as const) {
        await db.query(
          `INSERT INTO brain_pages (owner_id,slug,title,type,markdown,embedding,embedding_model,embedding_version,embedded_at)
        SELECT $1,'audit-'||i,'ANN fixture '||i,'note','Temporary HNSW regression fixture.',
          (ARRAY[$3::real,($4::real+i::real/10000)]||array_fill(0::real,ARRAY[1534]))::vector,$5,1,now()
        FROM generate_series(1,$2::integer) i`,
          [scope, count, first, second, embeddingModel()],
        );
      }
      const sql = `SELECT id FROM brain_pages WHERE owner_id=$1 AND embedding IS NOT NULL
      AND embedding_model=$3 AND embedding_version=version ORDER BY embedding <=> $2::vector,id LIMIT 50`;
      const params = [owner, JSON.stringify(vector), embeddingModel()];
      await db.query("BEGIN READ ONLY");
      inTransaction = true;
      await db.query("SET LOCAL enable_seqscan=off");
      await db.query("SET LOCAL enable_bitmapscan=off");
      await db.query("SET LOCAL enable_sort=off");
      await db.query(
        "SELECT set_config('hnsw.iterative_scan','off',true),set_config('hnsw.ef_search','40',true)",
      );
      const plan = await db.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
      assert.ok(
        JSON.stringify(plan.rows).includes("brain_pages_embedding_idx"),
        "Regression must exercise the approximate vector index",
      );
      const original = await db.query(sql, params);
      assert.ok(
        original.rows.length < 50,
        "Default filtered ANN must demonstrate candidate underfill",
      );
      await db.query(
        "SELECT set_config('hnsw.iterative_scan','strict_order',true),set_config('hnsw.ef_search','60',true),set_config('hnsw.max_scan_tuples','20000',true)",
      );
      const tuned = await db.query(sql, params);
      assert.equal(tuned.rows.length, 50);
      t.diagnostic(
        `Forced HNSW: default candidates returned ${original.rows.length}; bounded iterative scan returned ${tuned.rows.length}.`,
      );
      await db.query("ROLLBACK");
      inTransaction = false;
      const before = (await db.query("SHOW hnsw.iterative_scan")).rows[0][
        "hnsw.iterative_scan"
      ];
      assert.notEqual(before, "strict_order");
      const results = await search(owner, {
        query: "unmatched-hnsw-query",
        embedding: vector,
        embeddingModel: embeddingModel(),
        limit: 50,
        expandGraph: false,
      });
      assert.equal(results.length, 50);
      assert.ok(results.every((result) => result.matchedBy.includes("vector")));
      assert.equal(
        (await db.query("SHOW hnsw.iterative_scan")).rows[0][
          "hnsw.iterative_scan"
        ],
        before,
      );
    } finally {
      if (inTransaction) await db.query("ROLLBACK");
      await db.query("DELETE FROM brain_pages WHERE owner_id=ANY($1::text[])", [
        [owner, distractor],
      ]);
      db.release();
      await getPool().end();
    }
  },
);
