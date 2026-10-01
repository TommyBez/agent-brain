import assert from "node:assert/strict";
import test from "node:test";
import * as brain from "../lib/brain/service";
import { planOperations } from "../lib/maintenance/consolidator/planner";
import {
  buildSnapshot,
  createAnalysisTasks,
  pageEvidenceFingerprint,
} from "../lib/maintenance/consolidator/snapshot";
import {
  planConsolidation,
  prepareConsolidationScan,
} from "../lib/maintenance/consolidator/steps";
import {
  readConsolidationRecord,
  saveConsolidationRecord,
} from "../lib/maintenance/consolidator/store";
import type {
  AnalysisResult,
  Snapshot,
} from "../lib/maintenance/consolidator/types";
import { residueAnalysis, storeFixture } from "./helpers/consolidator-store";

test(
  "consolidation store: reuse",
  { skip: !process.env.BRAIN_TEST_DATABASE_URL },
  async (t) => {
    const { owner, create, cleanup } = storeFixture();
    try {
      await t.test(
        "scan reuses local analysis across unrelated writes and refreshes referenced-source analysis",
        async () => {
          const localPage = await create();
          const corpusPage = await create();
          const unrelatedPage = await create();
          const snapshot = buildSnapshot([
            localPage,
            corpusPage,
            unrelatedPage,
          ]);
          const runId = "analysis-cache-scope";
          await saveConsolidationRecord(
            owner,
            runId,
            `snapshot:${snapshot.id}`,
            snapshot,
          );
          const tasks = createAnalysisTasks(snapshot);
          const storedSnapshot = await readConsolidationRecord<Snapshot>(
            owner,
            runId,
            `snapshot:${snapshot.id}`,
          );
          assert.ok(storedSnapshot);
          assert.deepEqual(
            createAnalysisTasks(storedSnapshot),
            tasks,
            "Persisting a snapshot as JSONB must preserve its task identities",
          );
          const localTask = tasks.find(
            (task) =>
              task.kind === "document" && task.pageIds[0] === localPage.id,
          );
          const corpusTask = tasks.find(
            (task) =>
              task.kind === "document" && task.pageIds[0] === corpusPage.id,
          );
          assert.ok(localTask && corpusTask);
          const localResult: AnalysisResult = {
            taskId: localTask.id,
            findings: [],
            judgments: [],
            status: "complete",
          };
          const corpusResult: AnalysisResult = {
            ...localResult,
            taskId: corpusTask.id,
            dependencies: [
              {
                pageId: unrelatedPage.id,
                fingerprint: pageEvidenceFingerprint(unrelatedPage),
              },
            ],
          };
          await saveConsolidationRecord(
            owner,
            runId,
            `analysis:${localTask.id}`,
            localResult,
          );
          await saveConsolidationRecord(
            owner,
            runId,
            `analysis:${corpusTask.id}`,
            corpusResult,
          );
          const initial = await prepareConsolidationScan(
            owner,
            runId,
            snapshot.id,
            100,
          );
          assert.equal(initial.reused, 2);
          assert.ok(
            initial.tasks.every(
              (task) => task.id !== localTask.id && task.id !== corpusTask.id,
            ),
          );
          const changed = await brain.append(owner, {
            ref: unrelatedPage.id,
            expectedVersion: unrelatedPage.version,
            markdown: "New evidence elsewhere in the corpus.",
          });
          const refreshed = buildSnapshot([localPage, corpusPage, changed]);
          await saveConsolidationRecord(
            owner,
            runId,
            `snapshot:${refreshed.id}`,
            refreshed,
          );
          const next = await prepareConsolidationScan(
            owner,
            runId,
            refreshed.id,
            100,
          );
          assert.deepEqual(next.cached, []);
          assert.equal(next.reused, 1);
          assert.ok(next.tasks.some((task) => task.id === corpusTask.id));
          assert.ok(!next.tasks.some((task) => task.id === localTask.id));
          const refreshedResult = {
            ...corpusResult,
            dependencies: [
              {
                pageId: changed.id,
                fingerprint: pageEvidenceFingerprint(changed),
              },
            ],
          };
          await saveConsolidationRecord(
            owner,
            `${runId}-next`,
            `analysis:${corpusTask.id}`,
            refreshedResult,
          );
          const completed = await prepareConsolidationScan(
            owner,
            runId,
            refreshed.id,
            100,
          );
          assert.equal(completed.reused, 2);
          assert.ok(!completed.tasks.some((task) => task.id === corpusTask.id));
          assert.deepEqual(
            await readConsolidationRecord(
              owner,
              runId,
              `analysis:${corpusTask.id}`,
            ),
            corpusResult,
            "Refreshing corpus evidence retains the original immutable audit",
          );
        },
      );
      await t.test(
        "planning counts cached capacity limits without selecting the same bounded work again",
        async () => {
          const target = await create();
          const unrelated = await create();
          const snapshot = buildSnapshot([target, unrelated]);
          const runId = "capacity-decision-cache";
          const result = residueAnalysis(snapshot, target.id);
          const [plan] = planOperations(snapshot, [result]);
          await saveConsolidationRecord(
            owner,
            runId,
            `snapshot:${snapshot.id}`,
            snapshot,
          );
          await saveConsolidationRecord(owner, runId, `decision:${plan.id}`, {
            operationId: plan.id,
            status: "uncertain",
            reason: "capacity",
            evidenceFingerprints: snapshot.pages
              .filter((page) =>
                plan.readSet.some((ref) => ref.pageId === page.id),
              )
              .map((page) => ({
                pageId: page.id,
                fingerprint: pageEvidenceFingerprint(page),
              })),
          });
          assert.deepEqual(
            await planConsolidation(owner, runId, snapshot.id, [result]),
            { selected: [], deferred: 0, capacityLimited: 1 },
          );
          const changed = await brain.append(owner, {
            ref: unrelated.id,
            expectedVersion: unrelated.version,
            markdown: "An unrelated page changed.",
          });
          const refreshed = buildSnapshot([target, changed]);
          await saveConsolidationRecord(
            owner,
            runId,
            `snapshot:${refreshed.id}`,
            refreshed,
          );
          assert.equal(planOperations(refreshed, [result])[0].id, plan.id);
          assert.deepEqual(
            await planConsolidation(owner, runId, refreshed.id, [result]),
            { selected: [], deferred: 0, capacityLimited: 1 },
          );
          const updatedTarget = await brain.append(owner, {
            ref: target.id,
            expectedVersion: target.version,
            markdown: "The operation's own evidence changed.",
          });
          const updated = buildSnapshot([updatedTarget, changed]);
          await saveConsolidationRecord(
            owner,
            runId,
            `snapshot:${updated.id}`,
            updated,
          );
          const updatedResult = residueAnalysis(updated, target.id);
          const updatedPlan = planOperations(updated, [updatedResult])[0];
          assert.notEqual(updatedPlan.id, plan.id);
          assert.deepEqual(
            await planConsolidation(owner, runId, updated.id, [updatedResult]),
            { selected: [updatedPlan], deferred: 0, capacityLimited: 0 },
          );
        },
      );
    } finally {
      await cleanup();
    }
  },
);
