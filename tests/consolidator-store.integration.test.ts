import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import * as brain from "../lib/brain/service";
import { BrainError, type BrainPage } from "../lib/brain/types";
import { getPool } from "../lib/db";
import { planOperations } from "../lib/maintenance/consolidator/planner";
import {
  buildSnapshot,
  createAnalysisTasks,
} from "../lib/maintenance/consolidator/snapshot";
import {
  initializeConsolidation,
  planConsolidation,
  prepareConsolidationScan,
} from "../lib/maintenance/consolidator/steps";
import {
  applyConsolidationChangeSet,
  beginConsolidationRun,
  findConsolidationRecord,
  findConsolidationRecords,
  finishConsolidationRun,
  readConsolidationPages,
  readConsolidationRecord,
  saveConsolidationRecord,
} from "../lib/maintenance/consolidator/store";
import type {
  AnalysisResult,
  ChangeSet,
  Finding,
} from "../lib/maintenance/consolidator/types";
import { indexPageFixture } from "./helpers/brain-embeddings";

function changeSet(pages: BrainPage[], evidence: BrainPage[] = []): ChangeSet {
  const id = randomUUID();
  return {
    id,
    plan: {
      id,
      kind: "deduplicate",
      findingIds: [],
      targetPageIds: pages.map((page) => page.id),
      targetUnitIds: [],
      evidenceUnitIds: [],
      readSet: [...pages, ...evidence].map(({ id: pageId, version }) => ({
        pageId,
        version,
      })),
      goal: "Preserve the documented fact once.",
    },
    draft: {
      patches: pages.map((page) => ({
        pageId: page.id,
        unitId: `${page.id}:0`,
        before: page.markdown,
        after: `Consolidated: ${page.markdown}`,
      })),
      links: [],
      noChange: false,
    },
    changes: pages.map((before) => ({
      before,
      after: { ...before, markdown: `Consolidated: ${before.markdown}` },
    })),
  };
}

test(
  "consolidation persists coherent snapshots and atomic versioned groups",
  { skip: !process.env.BRAIN_TEST_DATABASE_URL },
  async (t) => {
    // Explicit isolated database opt-in. Never fall back to the developer's DB.
    process.env.DATABASE_URL = process.env.BRAIN_TEST_DATABASE_URL;
    const owner = `consolidator-${randomUUID()}`;
    const otherOwner = `consolidator-${randomUUID()}`;
    let counter = 0;
    const create = (who = owner) =>
      brain.write(who, {
        expectedVersion: 0,
        title: `Consolidator page ${counter++}`,
        type: "note",
        markdown: "A distinct documented fact.",
      });
    try {
      await t.test(
        "initialization starts automatic consolidation without a mode selector",
        async () => {
          const runId = "automatic-initialization";
          const options = await initializeConsolidation(owner, runId);
          assert.equal("mode" in options, false);
          assert.ok(options.maxWaves > 0);
          assert.ok(options.taskBudget > 0);
          assert.deepEqual(await readConsolidationRecord(owner, runId, "run"), {
            status: "started",
          });
        },
      );

      await t.test(
        "the snapshot includes every page, full bodies and owner-scoped graph",
        async () => {
          for (let i = 0; i < 35; i++) await create();
          const hidden = await create(otherOwner);
          const pages = await readConsolidationPages(owner);
          assert.equal(pages.length, 35);
          assert.ok(
            pages.every(
              (page) => page.markdown === "A distinct documented fact.",
            ),
          );
          assert.ok(!pages.some((page) => page.id === hidden.id));
          const linkSource = await brain.write(owner, {
            id: pages[0].id,
            expectedVersion: pages[0].version,
            title: pages[0].title,
            type: pages[0].type,
            markdown: pages[0].markdown,
            links: [
              { targetRef: pages[1].id, type: "references", label: "Source" },
            ],
          });
          const snapshot = await readConsolidationPages(owner);
          assert.equal(
            snapshot.find((page) => page.id === linkSource.id)?.links[0]
              .targetId,
            pages[1].id,
          );
          assert.equal(
            snapshot.find((page) => page.id === pages[1].id)?.backlinks[0]
              .sourceId,
            linkSource.id,
          );
        },
      );

      await t.test(
        "changes to evidence or any target invalidate the entire group",
        async () => {
          const a = await create();
          const b = await create();
          const evidence = await create();
          const set = changeSet([a, b], [evidence]);
          await brain.append(owner, {
            ref: evidence.id,
            expectedVersion: 1,
            markdown: "Evidence changed.",
          });
          assert.deepEqual(
            await applyConsolidationChangeSet(owner, set, "evidence-conflict"),
            { status: "conflict", pageIds: [evidence.id] },
          );
          assert.equal((await brain.read(owner, { ref: a.id })).version, 1);
          assert.equal((await brain.read(owner, { ref: b.id })).version, 1);
          const next = changeSet([a, b]);
          await brain.append(owner, {
            ref: b.id,
            expectedVersion: 1,
            markdown: "Target changed.",
          });
          assert.deepEqual(
            await applyConsolidationChangeSet(owner, next, "target-conflict"),
            { status: "conflict", pageIds: [b.id] },
          );
          assert.equal((await brain.read(owner, { ref: a.id })).version, 1);
        },
      );

      await t.test(
        "concurrent retries commit one group and replay the same receipt after later writes",
        async () => {
          const a = await create();
          const b = await create();
          const set = changeSet([a, b]);
          const results = await Promise.all([
            applyConsolidationChangeSet(owner, set, "group-retry"),
            applyConsolidationChangeSet(owner, set, "group-retry"),
          ]);
          assert.deepEqual(results.map((result) => result.status).sort(), [
            "applied",
            "replayed",
          ]);
          const applied = results.find((result) => result.status === "applied");
          assert.ok(applied && "pages" in applied);
          assert.ok(applied.pages.every((page) => page.version === 2));
          await brain.append(owner, {
            ref: a.id,
            expectedVersion: 2,
            markdown: "A later independent write.",
          });
          assert.deepEqual(
            await applyConsolidationChangeSet(owner, set, "group-retry"),
            { status: "replayed", pages: applied.pages },
          );
          assert.equal((await brain.read(owner, { ref: a.id })).version, 3);
          const counts = await getPool().query(
            "SELECT count(*)::int AS count FROM brain_activity WHERE owner_id=$1 AND source='nightly-consolidation' AND page_id=ANY($2::uuid[])",
            [owner, [a.id, b.id]],
          );
          assert.equal(counts.rows[0].count, 2);
          const altered = structuredClone(set);
          altered.changes[0].after.markdown += " Different.";
          await assert.rejects(
            applyConsolidationChangeSet(owner, altered, "group-retry"),
            (error) =>
              error instanceof BrainError &&
              error.code === "OPERATION_KEY_CONFLICT",
          );
        },
      );

      await t.test(
        "overlapping groups serialize and one becomes stale",
        async () => {
          const a = await create();
          const b = await create();
          const results = await Promise.all([
            applyConsolidationChangeSet(owner, changeSet([a, b]), "overlap-a"),
            applyConsolidationChangeSet(owner, changeSet([b, a]), "overlap-b"),
          ]);
          assert.deepEqual(results.map((result) => result.status).sort(), [
            "applied",
            "conflict",
          ]);
          assert.equal((await brain.read(owner, { ref: a.id })).version, 2);
          assert.equal((await brain.read(owner, { ref: b.id })).version, 2);
        },
      );

      await t.test(
        "foreign-owner targets and incomplete read sets cannot write",
        async () => {
          const a = await create();
          const hidden = await create(otherOwner);
          const set = changeSet([a], [hidden]);
          assert.deepEqual(
            await applyConsolidationChangeSet(owner, set, "foreign-evidence"),
            { status: "conflict", pageIds: [hidden.id] },
          );
          set.plan.readSet = [];
          await assert.rejects(
            applyConsolidationChangeSet(owner, set, "missing-read-set"),
          );
          assert.equal((await brain.read(owner, { ref: a.id })).version, 1);
        },
      );

      await t.test(
        "links, immutable metadata, revisions and chunk invalidation follow saved state",
        async () => {
          let a = await create();
          const b = await create();
          const c = await create();
          a = await brain.write(owner, {
            id: a.id,
            expectedVersion: a.version,
            title: a.title,
            type: a.type,
            markdown: a.markdown,
            summary: "Keep this summary.",
            aliases: ["Preserved alias"],
            tags: ["preserved"],
            links: [{ targetRef: b.id, type: "references", label: "Original" }],
          });
          await indexPageFixture(
            owner,
            a,
            Array.from({ length: 1536 }, (_, index) => Number(index === 0)),
          );
          a = await brain.read(owner, { ref: a.id });
          const set = changeSet([a], [c]);
          set.changes[0].after.summary =
            "Updated summary verified against the original sources.";
          const added = {
            sourceId: a.id,
            targetId: c.id,
            type: "depends_on" as const,
            label: "Verified dependency",
          };
          set.draft.links.push(added);
          set.changes[0].after.links = [
            ...a.links,
            { ...added, id: "draft-link" },
          ];
          const result = await applyConsolidationChangeSet(
            owner,
            set,
            "with-links",
          );
          assert.ok("pages" in result);
          const saved = result.pages[0];
          assert.deepEqual(saved, await brain.read(owner, { ref: a.id }));
          assert.equal(
            saved.links.find((link) => link.targetId === b.id)?.id,
            a.links[0].id,
          );
          assert.equal(
            saved.links.find((link) => link.targetId === c.id)?.type,
            "depends_on",
          );
          assert.equal(saved.summary, set.changes[0].after.summary);
          assert.equal(saved.slug, a.slug);
          assert.deepEqual(saved.aliases, a.aliases);
          assert.deepEqual(saved.tags, a.tags);
          assert.equal(saved.embeddedAt, null);
          assert.ok(
            (await brain.listPendingEmbeddings(owner, 100)).some(
              (page) => page.id === a.id,
            ),
          );
          const revisions = await brain.listRevisions(owner, { ref: a.id });
          assert.deepEqual(revisions[0].snapshot, saved);
          const tampered = changeSet([saved]);
          tampered.changes[0].after.title = "Unauthorized title";
          await assert.rejects(
            applyConsolidationChangeSet(owner, tampered, "tampered"),
            (error) =>
              error instanceof BrainError &&
              error.code === "INVALID_CHANGE_SET",
          );
        },
      );

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
                (await brain.listRevisions(owner, { ref: page.id })).length,
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
        "production steps load exact snapshots and keep legacy previews eligible for automatic application",
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
          assert.deepEqual(scan.cached, [{ ...original, judgments: [] }]);
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
                     error => error instanceof RetryableError && error.message === 'Consolidation database is temporarily unavailable.',
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
          // A legacy preview records an uncommitted proposal, never a completed
          // operation. Removing the mode switch must keep it eligible to apply.
          await saveConsolidationRecord(owner, runId, `decision:${plan.id}`, {
            operationId: plan.id,
            status: "preview",
            evidenceVersions: plan.readSet,
            verification: { judgments: ["Heavy audit retained"] },
          });
          assert.deepEqual(
            await planConsolidation(owner, runId, snapshot.id, [result]),
            { selected: [plan], deferred: 0 },
          );
        },
      );

      await t.test(
        "batched cache reads choose each owner's latest record without copying heavy audit fields",
        async () => {
          const older = {
            status: "complete",
            findings: ["older"],
            judgments: [{ state: "Full original evidence" }],
          };
          const newer = { ...older, findings: ["newer"] };
          await saveConsolidationRecord(
            owner,
            "batch-a",
            "cached-analysis",
            older,
          );
          await saveConsolidationRecord(
            owner,
            "batch-b",
            "cached-analysis",
            newer,
          );
          await saveConsolidationRecord(
            owner,
            "batch-a",
            "other-analysis",
            older,
          );
          await saveConsolidationRecord(
            otherOwner,
            "batch-z",
            "cached-analysis",
            { ...older, findings: ["private"] },
          );
          const cached = await findConsolidationRecords(
            owner,
            ["cached-analysis", "other-analysis", "missing", "cached-analysis"],
            ["judgments"],
          );
          assert.equal(cached.size, 2);
          assert.deepEqual(cached.get("cached-analysis"), {
            status: "complete",
            findings: ["newer"],
          });
          assert.deepEqual(cached.get("other-analysis"), {
            status: "complete",
            findings: ["older"],
          });
          assert.deepEqual(
            await readConsolidationRecord(owner, "batch-b", "cached-analysis"),
            newer,
            "the complete audit record is retained in storage",
          );
          assert.equal((await findConsolidationRecords(owner, [])).size, 0);
        },
      );

      await t.test(
        "audit records are immutable, owner-isolated and excluded from knowledge",
        async () => {
          const before = await brain.getStats(owner);
          await beginConsolidationRun(owner, "audit-run");
          assert.deepEqual(
            await readConsolidationRecord(owner, "audit-run", "run"),
            { status: "started" },
          );
          const snapshot = await readConsolidationPages(owner);
          await saveConsolidationRecord(
            owner,
            "audit-run",
            "snapshot",
            snapshot,
          );
          await saveConsolidationRecord(
            owner,
            "audit-run",
            "snapshot",
            snapshot,
          );
          assert.deepEqual(
            await readConsolidationRecord(owner, "audit-run", "snapshot"),
            snapshot,
          );
          assert.equal(
            await readConsolidationRecord(otherOwner, "audit-run", "snapshot"),
            null,
          );
          assert.deepEqual(
            await findConsolidationRecord(owner, "snapshot"),
            snapshot,
          );
          assert.equal(
            await findConsolidationRecord(otherOwner, "snapshot"),
            null,
          );
          await assert.rejects(
            saveConsolidationRecord(owner, "audit-run", "snapshot", []),
            (error) =>
              error instanceof BrainError && error.code === "RECORD_CONFLICT",
          );
          await finishConsolidationRun(owner, "audit-run", {
            status: "complete",
            applied: 0,
          });
          assert.deepEqual(await brain.getStats(owner), before);
        },
      );
    } finally {
      await getPool().query(
        "DELETE FROM brain_consolidation_records WHERE owner_id=ANY($1::text[])",
        [[owner, otherOwner]],
      );
      await getPool().query(
        "DELETE FROM brain_pages WHERE owner_id=ANY($1::text[])",
        [[owner, otherOwner]],
      );
      await getPool().end();
    }
  },
);
