import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getPool } from "../lib/db";
import { analyzeTask } from "../lib/maintenance/consolidator/analysis";
import { recordKeys } from "../lib/maintenance/consolidator/keys";
import {
  buildSnapshot,
  createAnalysisTasks,
} from "../lib/maintenance/consolidator/snapshot";
import {
  readConsolidationTaskSnapshot,
  saveConsolidationRecord,
} from "../lib/maintenance/consolidator/store";
import type { EvaluationRequest } from "../lib/maintenance/consolidator/types";
import { evaluator, page } from "./helpers/consolidator";

test(
  "task snapshot reduces database output while preserving analysis and explicit-source dependencies",
  {
    skip: !process.env.BRAIN_TEST_DATABASE_URL,
  },
  async () => {
    process.env.DATABASE_URL = process.env.BRAIN_TEST_DATABASE_URL;
    const owner = randomUUID();
    const a = page(
      "a",
      "Atlas uses PostgreSQL. See /pages/decision/source/ and /pages/missing/.",
    );
    const b = page("b", "Atlas uses MySQL.");
    const source = page(
      "source",
      "Decision: completed its migration. See /pages/unrelated/.",
    );
    source.slug = "decision/source";
    a.links.push({
      id: "link",
      sourceId: a.id,
      targetId: source.id,
      type: "references",
      label: "Source",
    });
    const snapshot = buildSnapshot([
      a,
      b,
      source,
      page("unrelated", "x".repeat(100_000)),
    ]);
    const task = createAnalysisTasks(snapshot).find(
      (task) => task.kind === "pair" && task.pageIds.join() === "a,b",
    );
    assert.ok(task);
    try {
      await saveConsolidationRecord(
        owner,
        "run",
        recordKeys.snapshot(snapshot.id),
        snapshot,
      );
      const scoped = await readConsolidationTaskSnapshot(
        owner,
        "run",
        snapshot.id,
        task.pageIds,
      );
      assert.ok(scoped);
      assert.deepEqual(scoped, {
        ...snapshot,
        pages: snapshot.pages.filter((p) => p.id !== "unrelated"),
        units: snapshot.units.filter((u) => u.pageId !== "unrelated"),
      });
      assert.ok(
        JSON.stringify(scoped).length < JSON.stringify(snapshot).length / 10,
      );
      const document = await readConsolidationTaskSnapshot(
        owner,
        "run",
        snapshot.id,
        [b.id],
      );
      assert.deepEqual(document, {
        ...snapshot,
        pages: [b],
        units: snapshot.units.filter((unit) => unit.pageId === b.id),
      });
      const before: EvaluationRequest[] = [],
        after: EvaluationRequest[] = [];
      const choose = (id: string, request: EvaluationRequest) => {
        if (
          ["conflict", "counterpart"].includes(id) ||
          id.startsWith("passage_")
        )
          return 1;
        if (id === "resolution")
          return JSON.stringify(request.state).includes(
            "completed its migration",
          )
            ? "a"
            : "insufficient";
        return 0;
      };
      assert.deepEqual(
        await analyzeTask(scoped, task, evaluator(choose, after)),
        await analyzeTask(snapshot, task, evaluator(choose, before)),
      );
      assert.deepEqual(after, before);
      assert.equal(
        await readConsolidationTaskSnapshot(
          randomUUID(),
          "run",
          snapshot.id,
          task.pageIds,
        ),
        null,
      );
      assert.equal(
        await readConsolidationTaskSnapshot(
          owner,
          "other-run",
          snapshot.id,
          task.pageIds,
        ),
        null,
      );
    } finally {
      await getPool().query(
        "DELETE FROM brain_consolidation_records WHERE owner_id=$1",
        [owner],
      );
      await getPool().end();
    }
  },
);
