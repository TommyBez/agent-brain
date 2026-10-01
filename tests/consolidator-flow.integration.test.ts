import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import * as brain from "../lib/brain/service";
import { getPool } from "../lib/db";
import { runConsolidation } from "../lib/maintenance/consolidator/runner";
import * as steps from "../lib/maintenance/consolidator/steps";
import type {
  Answer,
  EvaluationRequest,
} from "../lib/maintenance/consolidator/types";

test(
  "production steps apply a link, resume changed pairs and converge to zero provider calls",
  { skip: !process.env.BRAIN_TEST_DATABASE_URL },
  async (t) => {
    process.env.DATABASE_URL = process.env.BRAIN_TEST_DATABASE_URL;
    t.mock.method(
      createRequire(import.meta.url)("next/cache"),
      "revalidateTag",
      () => undefined,
    );
    const previousKey = process.env.AI_GATEWAY_API_KEY;
    process.env.AI_GATEWAY_API_KEY = "test-only";
    const owner = `flow-${randomUUID()}`;
    t.after(async () => {
      for (const table of [
        "brain_consolidation_spend",
        "brain_consolidation_queue",
        "brain_consolidation_records",
        "brain_activity",
        "brain_pages",
      ])
        await getPool().query(`DELETE FROM ${table} WHERE owner_id=$1`, [
          owner,
        ]);
      if (previousKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = previousKey;
      await getPool().end();
    });
    const person = await brain.write(owner, {
      expectedVersion: 0,
      title: "Giulia",
      type: "person",
      markdown: "Giulia works at Atlas.",
    });
    const company = await brain.write(owner, {
      expectedVersion: 0,
      title: "Atlas",
      type: "company",
      relationships: ["client"],
      markdown: "Atlas is a software company.",
    });
    const provider = t.mock.method(
      globalThis,
      "fetch",
      async (url: string | URL | Request, init?: RequestInit) => {
        assert.match(String(url), /\/evaluate$/); // A link does not need DeepSeek.
        const request = JSON.parse(String(init?.body)) as EvaluationRequest;
        const state = request.state as {
          pages?: { id: string; links: { targetId: string; type: string }[] }[];
        };
        const answers: Record<string, Answer> = {};
        for (const [id, question] of Object.entries(request.questions)) {
          if (question.type === "choice")
            answers[id] = {
              type: "choice",
              choice: "works_at",
              confidence: 1,
              probabilities: Object.fromEntries(
                Object.keys(question.criteria).map((key) => [
                  key,
                  key === "works_at" ? 1 : 0,
                ]),
              ),
            };
          else {
            let probability = 1;
            if (["duplicate", "conflict", "residue"].includes(id))
              probability = 0;
            if (id === "link_ab" || id === "link_ba") {
              const source = state.pages?.[id === "link_ab" ? 0 : 1];
              probability =
                source?.id === person.id &&
                !source.links.some(
                  (link) =>
                    link.targetId === company.id && link.type === "works_at",
                )
                  ? 1
                  : 0;
            }
            answers[id] = { type: "boolean", probability };
          }
        }
        return Response.json({
          model: "typesafe-ai/jev",
          answers,
          usage: { inputTokens: 100, outputTokens: 0 },
          providerMetadata: { gateway: { cost: "0.0000042" } },
        });
      },
    );
    const run = async () => {
      const runId = randomUUID();
      const options = await steps.initializeConsolidation(owner, runId);
      return runConsolidation(
        {
          snapshot: () => steps.snapshotConsolidation(owner, runId),
          scan: (snapshotId, budget) =>
            steps.prepareConsolidationScan(owner, runId, snapshotId, budget),
          analyze: (snapshotId, task) =>
            steps.analyzeConsolidationTask(owner, runId, snapshotId, task),
          plan: (snapshotId, results) =>
            steps.planConsolidation(owner, runId, snapshotId, results),
          draft: (snapshotId, plan, attempt, feedback) =>
            steps.draftConsolidation(
              owner,
              runId,
              snapshotId,
              plan,
              attempt,
              feedback,
            ),
          review: (snapshotId, plan, draft) =>
            steps.reviewConsolidation(owner, runId, snapshotId, plan, draft),
          apply: (changeSet) =>
            steps.applyConsolidation(owner, runId, changeSet),
          record: (key, value) =>
            steps.recordConsolidation(owner, runId, key, value),
          queue: (ids) => steps.queueConsolidation(owner, ids),
        },
        options,
      );
    };
    const first = await run();
    assert.equal(first.writes, 1, JSON.stringify(first));
    const current = await brain.read(owner, { ref: person.id });
    assert.ok(
      current.links.some(
        (link) => link.targetId === company.id && link.type === "works_at",
      ),
    );
    assert.equal(current.markdown, person.markdown);
    const second = await run();
    assert.equal(second.writes, 0);
    assert.equal(second.remainingTasks, 0);
    const calls = provider.mock.callCount();
    const third = await run();
    assert.equal(third.reusedTasks, 3);
    assert.equal(third.remainingTasks, 0);
    assert.equal(provider.mock.callCount(), calls);
    const { readConsolidationQueue } = await import(
      "../lib/maintenance/consolidator/store"
    );
    assert.deepEqual(await readConsolidationQueue(owner), []);
    const costs = await getPool().query(
      "SELECT count(*)::int AS calls,sum(actual_nano)::text AS cost FROM brain_consolidation_spend WHERE owner_id=$1",
      [owner],
    );
    assert.equal(costs.rows[0].calls, calls);
    assert.equal(Number(costs.rows[0].cost), calls * 4200);
  },
);
