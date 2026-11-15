import assert from "node:assert/strict";
import test from "node:test";
import { getPool } from "../lib/db";
import {
  evaluatePersisted,
  evaluationCacheKey,
} from "../lib/maintenance/consolidator/evaluation-cache";
import { JEV_MODEL } from "../lib/maintenance/consolidator/jev";
import { retainConsolidationRecords } from "../lib/maintenance/consolidator/retention";
import {
  buildSnapshot,
  createAnalysisTasks,
} from "../lib/maintenance/consolidator/snapshot";
import { prepareConsolidationScan } from "../lib/maintenance/consolidator/steps";
import {
  readConsolidationRecord,
  saveConsolidationRecord,
} from "../lib/maintenance/consolidator/store";
import { storeFixture } from "./helpers/consolidator-store";

test(
  "retention: bounded owner-only pruning, compact diagnostics and stable-page reuse",
  {
    skip: !process.env.BRAIN_TEST_DATABASE_URL,
  },
  async (t) => {
    const { owner, otherOwner, create, cleanup } = storeFixture();
    const pool = getPool();
    try {
      const page = await create();
      const snapshot = buildSnapshot([page]);
      const [task] = createAnalysisTasks(snapshot);
      const request = {
        state: { text: "Synthetic source evidence" },
        questions: {
          objective: {
            type: "boolean" as const,
            instructions: "Is it documented?",
          },
        },
      };
      const evaluation = {
        model: JEV_MODEL,
        answers: { objective: { type: "boolean" as const, probability: 0.2 } },
        promptVersion: "synthetic-v1",
        inputTokens: 30,
        outputTokens: 2,
      };
      const evaluationKey = evaluationCacheKey(request);
      const analysisKey = `analysis:${task.id}`;
      const analysis = {
        taskId: task.id,
        status: "complete",
        findings: [],
        judgments: [{ ...request, ...evaluation }],
      };
      for (const key of [analysisKey, "verification:compact"]) {
        await saveConsolidationRecord(owner, "kept", key, analysis);
        const stored = await readConsolidationRecord<{ judgments: unknown[] }>(
          owner,
          "kept",
          key,
        );
        assert.deepEqual(stored?.judgments, [{ evaluationKey, ...evaluation }]);
        assert.ok(
          !JSON.stringify(stored).includes("Synthetic source evidence"),
        );
      }
      await pool.query(
        `INSERT INTO brain_consolidation_records VALUES ($1,'legacy','record','analysis:legacy',$2::jsonb,now()-interval '61 days')`,
        [owner, JSON.stringify(analysis)],
      );
      await saveConsolidationRecord(
        owner,
        "legacy",
        "analysis:legacy",
        analysis,
      );
      assert.deepEqual(
        await readConsolidationRecord(owner, "legacy", "analysis:legacy"),
        analysis,
      );
      await saveConsolidationRecord(
        owner,
        "old-evaluation",
        evaluationKey,
        evaluation,
      );
      await saveConsolidationRecord(owner, "superseded", analysisKey, analysis);
      await saveConsolidationRecord(otherOwner, "untouched", "run", {});
      await pool.query(
        `UPDATE brain_consolidation_records SET created_at=now()-interval '59 days' WHERE owner_id=$1 AND run_id='kept'`,
        [owner],
      );
      await pool.query(
        `UPDATE brain_consolidation_records SET created_at=now()-interval '90 days' WHERE owner_id=$1 AND run_id IN ('old-evaluation','superseded')`,
        [owner],
      );
      // More than two batches of stale per-run records, plus all cache families.
      await pool.query(
        `INSERT INTO brain_consolidation_records(owner_id,run_id,kind,record_key,payload,created_at)
      SELECT $1,'stale-'||n,'record','run','{}',now()-interval '15 days' FROM generate_series(1,1001) n`,
        [owner],
      );
      for (const prefix of [
        "analysis:",
        "evaluation:",
        "decision:",
        "task-keeper:",
      ]) {
        for (const days of [59, 61])
          await pool.query(
            `INSERT INTO brain_consolidation_records VALUES ($1,'age-test','record',$2,'{}',now()-$3::interval)`,
            [owner, `${prefix}${days}`, `${days} days`],
          );
      }
      for (const key of ["apply", "task-links:legacy"])
        await pool.query(
          `INSERT INTO brain_consolidation_records VALUES ($1,'operations','receipt',$2,'{}',now()-interval '200 days')`,
          [owner, key],
        );
      await pool.query(
        `INSERT INTO brain_page_chunks
      (owner_id,page_id,page_version,embedding_model,chunker_version,chunk_index,content_hash,content,start_offset,end_offset,token_count,embedding)
      VALUES ($1,$2,1,'synthetic','synthetic',0,$3,'Synthetic chunk',0,15,3,$4::vector)`,
        [
          owner,
          page.id,
          "a".repeat(64),
          `[${Array(1536).fill(0.1).join(",")}]`,
        ],
      );
      // Snapshot every non-operational table, including pages/revisions/chunks/tasks.
      const tables = await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'brain_consolidation_records' ORDER BY tablename`,
      );
      const capture = async () =>
        Promise.all(
          tables.rows.map(async ({ tablename }) => {
            assert.match(tablename, /^[a-zA-Z_]+$/);
            return (
              await pool.query(
                `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM "${tablename}" t`,
              )
            ).rows[0].rows;
          }),
        );
      const before = await capture();
      const count = async () =>
        (
          await pool.query(
            `SELECT count(*)::int AS n FROM brain_consolidation_records WHERE owner_id=$1`,
            [owner],
          )
        ).rows[0].n as number;
      const recordsBefore = await count();
      const result = await retainConsolidationRecords(owner);
      const recordsAfter = await count();
      assert.equal(recordsBefore - recordsAfter, result.deleted);
      assert.equal(result.deleted, 1008); // run rows, superseded analysis, expired verification, four caches
      assert.equal(result.batches, 3);
      assert.deepEqual(await capture(), before);
      assert.ok(await readConsolidationRecord(otherOwner, "untouched", "run"));
      assert.ok(
        await readConsolidationRecord(owner, "old-evaluation", evaluationKey),
      );
      for (const prefix of [
        "analysis:",
        "evaluation:",
        "decision:",
        "task-keeper:",
      ]) {
        assert.ok(
          await readConsolidationRecord(owner, "age-test", `${prefix}59`),
        );
        assert.equal(
          await readConsolidationRecord(owner, "age-test", `${prefix}61`),
          null,
        );
      }
      assert.equal(
        (
          await pool.query(
            `SELECT count(*)::int AS n FROM brain_consolidation_records WHERE owner_id=$1 AND kind='receipt'`,
            [owner],
          )
        ).rows[0].n,
        2,
      );
      assert.equal((await retainConsolidationRecords(owner)).deleted, 0);
      const provider = t.mock.method(globalThis, "fetch", async () => {
        throw new Error("No paid JEV calls allowed");
      });
      await saveConsolidationRecord(
        owner,
        "tonight",
        `snapshot:${snapshot.id}`,
        snapshot,
      );
      const scan = await prepareConsolidationScan(
        owner,
        "tonight",
        snapshot.id,
        100,
      );
      assert.equal(scan.reused, 1);
      assert.equal(scan.tasks.length, 0);
      assert.deepEqual(
        await evaluatePersisted(owner, "tonight", request, async () => {
          throw new Error("No paid JEV calls allowed");
        }),
        evaluation,
      );
      assert.equal(provider.mock.callCount(), 0);
      // Once the analysis expires, its older evaluation may be pruned too.
      await pool.query(
        `UPDATE brain_consolidation_records SET created_at=now()-interval '61 days' WHERE owner_id=$1 AND run_id='kept'`,
        [owner],
      );
      assert.equal((await retainConsolidationRecords(owner)).deleted, 2);
      assert.equal(
        await readConsolidationRecord(owner, "old-evaluation", evaluationKey),
        null,
      );
      console.log(
        `Synthetic retention: before=${recordsBefore}, after=${recordsAfter}, deleted=${result.deleted}, batches=${result.batches}; receipts=2; stable-page provider calls=0; all other tables unchanged`,
      );
    } finally {
      await cleanup();
    }
  },
);
