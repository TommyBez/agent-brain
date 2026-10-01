import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as brain from "../../lib/brain/service";
import type { BrainPage } from "../../lib/brain/types";
import { getPool } from "../../lib/db";
import type {
  AnalysisResult,
  ChangeSet,
  Snapshot,
} from "../../lib/maintenance/consolidator/types";
export function changeSet(
  pages: BrainPage[],
  evidence: BrainPage[] = [],
): ChangeSet {
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

export function residueAnalysis(
  snapshot: Snapshot,
  pageId: string,
): AnalysisResult {
  const unit = snapshot.units.find((entry) => entry.pageId === pageId);
  assert.ok(unit);
  return {
    taskId: `residue:${unit.id}`,
    findings: [
      {
        id: `residue:${unit.id}`,
        kind: "remove_maintenance_residue",
        status: "supported",
        pageIds: [pageId],
        unitIds: [unit.id],
        evidenceUnitIds: [unit.id],
        goal: "Remove activity-only residue.",
      },
    ],
    judgments: [],
    status: "complete",
  };
}

export function storeFixture() {
  process.env.DATABASE_URL = process.env.BRAIN_TEST_DATABASE_URL;
  const owner = `consolidator-${randomUUID()}`,
    otherOwner = `consolidator-${randomUUID()}`;
  let counter = 0;
  const create = (who = owner) =>
    brain.write(who, {
      expectedVersion: 0,
      title: `Consolidator page ${counter++}`,
      type: "note",
      markdown: "A distinct documented fact.",
    });
  async function cleanup() {
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
  return { owner, otherOwner, create, cleanup };
}
