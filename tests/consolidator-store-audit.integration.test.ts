import assert from "node:assert/strict";
import test from "node:test";
import { readConsolidationPages } from "../lib/brain/consolidation";
import * as brain from "../lib/brain/service";
import { BrainError } from "../lib/brain/types";
import { buildSnapshot } from "../lib/maintenance/consolidator/snapshot";
import {
  draftConsolidation,
  reviewConsolidation,
} from "../lib/maintenance/consolidator/steps";
import {
  beginConsolidationRun,
  findConsolidationRecord,
  findConsolidationRecords,
  finishConsolidationRun,
  readConsolidationRecord,
  saveConsolidationRecord,
} from "../lib/maintenance/consolidator/store";
import {
  type Draft,
  type OperationPlan,
  POLICY,
} from "../lib/maintenance/consolidator/types";
import { storeFixture } from "./helpers/consolidator-store";

test(
  "consolidation store: audit",
  { skip: !process.env.BRAIN_TEST_DATABASE_URL },
  async (t) => {
    const { owner, otherOwner, cleanup } = storeFixture();
    let counter = 0;
    try {
      await t.test(
        "production draft and review steps return size limits as serializable capacity outcomes",
        async (t) => {
          const provider = t.mock.method(globalThis, "fetch", async () => {
            throw new Error("Capacity-limited steps must not call a provider");
          });
          const runId = "step-capacity-outcomes";
          const prepare = async (characters: number) => {
            const page = await brain.write(owner, {
              expectedVersion: 0,
              title: `Capacity fixture ${counter++}`,
              type: "note",
              markdown: "A".repeat(characters),
            });
            const snapshot = buildSnapshot([page]);
            await saveConsolidationRecord(
              owner,
              runId,
              `snapshot:${snapshot.id}`,
              snapshot,
            );
            const unit = snapshot.units[0];
            const plan: OperationPlan = {
              id: `capacity:${page.id}`,
              kind: "remove_maintenance_residue",
              findingIds: [],
              targetPageIds: [page.id],
              targetUnitIds: [unit.id],
              evidenceUnitIds: [unit.id],
              readSet: [{ pageId: page.id, version: page.version }],
              goal: "Remove activity-only residue.",
            };
            const draft: Draft = {
              noChange: false,
              links: [],
              patches: [
                {
                  pageId: page.id,
                  unitId: unit.id,
                  before: unit.text,
                  after: "Retained fact.",
                },
              ],
            };
            return { snapshot, plan, draft };
          };
          const large = await prepare(POLICY.evaluationCharacters + 10_000);
          const editor = await draftConsolidation(
            owner,
            runId,
            large.snapshot.id,
            large.plan,
            0,
          );
          assert.ok("capacity" in editor);
          assert.equal(editor.capacity.stage, "editor");
          assert.equal(
            editor.capacity.limitCharacters,
            POLICY.evaluationCharacters,
          );
          assert.deepEqual(JSON.parse(JSON.stringify(editor)), editor);
          const materialization = await reviewConsolidation(
            owner,
            runId,
            large.snapshot.id,
            large.plan,
            large.draft,
          );
          assert.ok(!("halt" in materialization));
          assert.equal(materialization.changeSet, null);
          assert.equal(materialization.verification.status, "uncertain");
          assert.equal(materialization.verification.incomplete, true);
          assert.equal(
            materialization.verification.capacity?.stage,
            "materialization",
          );
          const bounded = await prepare(
            Math.floor(POLICY.evaluationCharacters * 0.6),
          );
          const review = await reviewConsolidation(
            owner,
            runId,
            bounded.snapshot.id,
            bounded.plan,
            bounded.draft,
          );
          assert.ok(!("halt" in review));
          assert.ok(review.changeSet);
          assert.equal(review.verification.status, "uncertain");
          assert.equal(review.verification.incomplete, true);
          assert.equal(review.verification.capacity?.stage, "verification");
          assert.equal(provider.mock.callCount(), 0);
          for (const fixture of [large, bounded]) {
            const current = await brain.read(owner, {
              ref: fixture.snapshot.pages[0].id,
            });
            assert.equal(current.version, fixture.snapshot.pages[0].version);
            assert.equal(current.markdown, fixture.snapshot.pages[0].markdown);
          }
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
      await cleanup();
    }
  },
);
