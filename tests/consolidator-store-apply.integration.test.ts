import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import * as brain from "../lib/brain/service";
import { getPool } from "../lib/db";
import { planOperations } from "../lib/maintenance/consolidator/planner";
import {
  buildSnapshot,
  createAnalysisTasks,
} from "../lib/maintenance/consolidator/snapshot";
import {
  planConsolidation,
  prepareConsolidationScan,
  queueConsolidation,
} from "../lib/maintenance/consolidator/steps";
import {
  applyConsolidationChangeSet,
  readConsolidationQueue,
  readConsolidationRecord,
  saveConsolidationRecord,
} from "../lib/maintenance/consolidator/store";
import type {
  AnalysisResult,
  Finding,
} from "../lib/maintenance/consolidator/types";
import { changeSet, storeFixture } from "./helpers/consolidator-store";

test(
  "consolidation store: apply",
  { skip: !process.env.BRAIN_TEST_DATABASE_URL },
  async (t) => {
    const { owner, otherOwner, create, cleanup } = storeFixture();
    try {
      await t.test(
        "a late database failure rolls back all pages, revisions and the receipt",
        async () => {
          const pages = [await create(), await create()].sort((a, b) =>
            a.id.localeCompare(b.id),
          );
          const triggerId = `consolidator_${randomUUID().replaceAll("-", "")}`;
          // Test-only fault after the first page update. The trigger is scoped to
          // this isolated test owner and is always removed in the finally block.
          await getPool().query(
            `CREATE FUNCTION ${triggerId}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'consolidator atomicity test'; END $$`,
          );
          try {
            await getPool().query(
              `CREATE TRIGGER ${triggerId} BEFORE UPDATE ON brain_pages FOR EACH ROW WHEN (OLD.id = '${pages[1].id}'::uuid) EXECUTE FUNCTION ${triggerId}()`,
            );
            await assert.rejects(
              applyConsolidationChangeSet(owner, changeSet(pages), "rollback"),
              /consolidator atomicity test/,
            );
            for (const page of pages) {
              assert.equal(
                (await brain.read(owner, { ref: page.id })).version,
                1,
              );
              assert.equal(
                (await brain.listRevisionSummaries(owner, { ref: page.id }))
                  .length,
                1,
              );
            }
            const receipt = await getPool().query(
              "SELECT count(*)::int AS count FROM brain_consolidation_records WHERE owner_id=$1 AND kind='receipt' AND record_key='rollback'",
              [owner],
            );
            assert.equal(receipt.rows[0].count, 0);
          } finally {
            await getPool().query(
              `DROP TRIGGER IF EXISTS ${triggerId} ON brain_pages`,
            );
            await getPool().query(`DROP FUNCTION ${triggerId}()`);
          }
          assert.equal(
            (
              await applyConsolidationChangeSet(
                owner,
                changeSet(pages),
                "rollback",
              )
            ).status,
            "applied",
          );
        },
      );
      await t.test(
        "production steps load exact snapshots and plan automatic application",
        async () => {
          const snapshot = buildSnapshot([await create(), await create()]);
          const runId = "step-snapshot";
          await saveConsolidationRecord(
            owner,
            runId,
            `snapshot:${snapshot.id}`,
            snapshot,
          );
          const tasks = createAnalysisTasks(snapshot);
          const original: AnalysisResult = {
            taskId: tasks[0].id,
            findings: [],
            status: "complete",
            judgments: [
              {
                state: { source: "Unmodified complete evidence" },
                questions: {},
                answers: {},
                model: "fixture",
                inputTokens: 0,
                outputTokens: 0,
              },
            ],
          };
          await saveConsolidationRecord(
            owner,
            runId,
            `analysis:${tasks[0].id}`,
            original,
          );
          const scan = await prepareConsolidationScan(
            owner,
            runId,
            snapshot.id,
            1,
          );
          assert.equal(scan.total, 3);
          assert.equal(scan.tasks.length, 1);
          assert.equal(scan.remaining, 1);
          assert.deepEqual(scan.cached, []);
          assert.equal(scan.reused, 1);
          assert.equal("order" in scan, false);
          assert.deepEqual(
            await readConsolidationQueue(owner),
            tasks.slice(1).map((task) => task.id),
          );
          await queueConsolidation(owner, [scan.tasks[0].id]);
          assert.deepEqual(
            await readConsolidationQueue(owner),
            tasks.slice(2).map((task) => task.id),
          );
          // Replaying the completion delta preserves the unscheduled tail.
          await queueConsolidation(owner, [scan.tasks[0].id]);
          assert.equal((await readConsolidationQueue(owner)).length, 1);
          assert.deepEqual(
            await readConsolidationRecord(
              owner,
              runId,
              `analysis:${tasks[0].id}`,
            ),
            original,
          );
          // Plain tsx compiles this .ts test to CJS; workflow's require export is
          // its TypeScript plugin. Exercise the error branch with the package's
          // real runtime condition rather than accepting that loader TypeError.
          execFileSync(
            process.execPath,
            [
              "--conditions=workflow",
              "--import",
              "tsx",
              "-e",
              `const assert = require('node:assert/strict');
             const { FatalError, RetryableError } = require('workflow');
             const { prepareConsolidationScan, analyzeConsolidationTask } = require('./lib/maintenance/consolidator/steps.ts');
             const { getPool } = require('./lib/db.ts');
             (async () => {
               assert.equal(typeof FatalError, 'function');
               try {
                 await assert.rejects(
                   prepareConsolidationScan(process.argv[1], process.argv[2], process.argv[3], 1),
                   error => error instanceof FatalError && /immutable consolidation snapshot is unavailable/.test(error.message),
                 );
                 await assert.rejects(
                   analyzeConsolidationTask(process.argv[1], process.argv[2], process.argv[3], {}),
                   error => error instanceof FatalError && /immutable consolidation snapshot is unavailable/.test(error.message),
                 );
                 const pool = getPool();
                 const query = pool.query;
                 pool.query = async () => { const error = new Error('Private driver detail'); error.code = '57P03'; throw error; };
                 try {
                   await assert.rejects(
                     analyzeConsolidationTask(process.argv[1], process.argv[2], process.argv[3], {}),
                     error => error instanceof RetryableError && error.message === 'Consolidation failure [database:57P03:retry]',
                   );
                 } finally { pool.query = query; }
               } finally { await getPool().end(); }
             })().catch(error => { console.error(error); process.exitCode = 1; });`,
              otherOwner,
              runId,
              snapshot.id,
            ],
            {
              cwd: process.cwd(),
              timeout: 30_000,
              env: {
                ...process.env,
                DATABASE_URL: process.env.BRAIN_TEST_DATABASE_URL,
              },
              stdio: "pipe",
            },
          );
          const unit = snapshot.units[0];
          const finding: Finding = {
            id: "step-finding",
            kind: "remove_maintenance_residue",
            status: "supported",
            pageIds: [unit.pageId],
            unitIds: [unit.id],
            evidenceUnitIds: [unit.id],
            goal: "Remove activity-only residue.",
          };
          const result: AnalysisResult = {
            taskId: tasks[0].id,
            findings: [finding],
            judgments: [],
            status: "complete",
          };
          const [plan] = planOperations(snapshot, [result]);
          assert.deepEqual(
            await planConsolidation(owner, runId, snapshot.id, [result]),
            { selected: [plan], deferred: 0, capacityLimited: 0 },
          );
        },
      );
    } finally {
      await cleanup();
    }
  },
);
