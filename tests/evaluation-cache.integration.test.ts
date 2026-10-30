import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fingerprint } from "../lib/canonical-json";
import { getPool } from "../lib/db";
import { BudgetExhaustedError } from "../lib/maintenance/consolidator/budget";
import {
  evaluatePersisted,
  evaluationCacheKey,
} from "../lib/maintenance/consolidator/evaluation-cache";
import { JEV_MODEL } from "../lib/maintenance/consolidator/jev";
import { recordKeys } from "../lib/maintenance/consolidator/keys";
import {
  findConsolidationRecord,
  saveConsolidationRecord,
} from "../lib/maintenance/consolidator/store";
import type {
  Evaluation,
  EvaluationRequest,
} from "../lib/maintenance/consolidator/types";
import type { GatewayCall } from "../lib/maintenance/gateway";
import { GatewayRequestError } from "../lib/maintenance/gateway";

function request(state: string): EvaluationRequest {
  return {
    state: { task: { title: state } },
    questions: {
      relevant_p1: {
        type: "boolean",
        instructions: "Does page p1 hold knowledge this task should use?",
      },
    },
  };
}

function gateway(probability = 0.9) {
  const calls: { path: string; body: unknown }[] = [];
  const send = (async (path: string, body: unknown) => {
    calls.push({ path, body });
    return {
      model: JEV_MODEL,
      answers: { relevant_p1: { type: "boolean", probability } },
      usage: { inputTokens: 100, outputTokens: 1 },
    };
  }) as GatewayCall;
  return { send, calls };
}

test("the shared evaluation key is unchanged by the move out of steps.ts", () => {
  const input = request("Prepare the clinical studies report");
  assert.equal(
    evaluationCacheKey(input),
    recordKeys.evaluation(fingerprint({ model: JEV_MODEL, request: input })),
  );
  assert.notEqual(
    evaluationCacheKey(input),
    evaluationCacheKey(request("Another task")),
  );
});

test(
  "persisted Jev evaluations are shared across runs and purposes, per owner",
  { skip: !process.env.BRAIN_TEST_DATABASE_URL },
  async (t) => {
    process.env.DATABASE_URL = process.env.BRAIN_TEST_DATABASE_URL;
    const owner = `evaluation-cache-${randomUUID()}`;
    const other = `${owner}-other`;
    t.after(async () => {
      await getPool().query(
        "DELETE FROM brain_consolidation_records WHERE owner_id=ANY($1::text[])",
        [[owner, other]],
      );
      await getPool().end();
    });

    await t.test(
      "a miss pays through the given gateway and stores under the run",
      async () => {
        const input = request("Miss then hit");
        const pages = gateway();
        const evaluation = await evaluatePersisted(
          owner,
          "pages-run",
          input,
          pages.send,
        );
        assert.equal(pages.calls.length, 1);
        assert.equal(pages.calls[0].path, "evaluate");
        assert.deepEqual(pages.calls[0].body, { model: JEV_MODEL, ...input });
        assert.equal(
          (evaluation.answers.relevant_p1 as { probability: number })
            .probability,
          0.9,
        );
        const { rows } = await getPool().query(
          `SELECT run_id FROM brain_consolidation_records
           WHERE owner_id=$1 AND kind='record' AND record_key=$2`,
          [owner, evaluationCacheKey(input)],
        );
        assert.deepEqual(rows, [{ run_id: "pages-run" }]);

        const links = gateway(0.1);
        assert.deepEqual(
          await evaluatePersisted(owner, "task-links-run", input, links.send),
          evaluation,
        );
        assert.equal(links.calls.length, 0);

        const outsider = gateway(0.2);
        const separate = await evaluatePersisted(
          other,
          "pages-run",
          input,
          outsider.send,
        );
        assert.equal(outsider.calls.length, 1);
        assert.equal(
          (separate.answers.relevant_p1 as { probability: number }).probability,
          0.2,
        );
      },
    );

    await t.test(
      "a concurrent commit of the same key wins over the late answer",
      async () => {
        const input = request("Concurrent writers");
        const committed: Evaluation = {
          model: JEV_MODEL,
          answers: { relevant_p1: { type: "boolean", probability: 0.3 } },
          inputTokens: 100,
          outputTokens: 1,
        };
        const racing = (async (path: string, body: unknown) => {
          await saveConsolidationRecord(
            owner,
            "race-run",
            evaluationCacheKey(input),
            committed,
          );
          return gateway(0.95).send(path as "evaluate", body);
        }) as GatewayCall;
        assert.deepEqual(
          await evaluatePersisted(owner, "race-run", input, racing),
          committed,
        );
      },
    );

    await t.test(
      "budget exhaustion propagates silently and stores nothing",
      async () => {
        const input = request("Over budget");
        const error = t.mock.method(console, "error", () => {});
        await assert.rejects(
          evaluatePersisted(owner, "budget-run", input, (async () => {
            throw new BudgetExhaustedError("task_links");
          }) as GatewayCall),
          (thrown) =>
            thrown instanceof BudgetExhaustedError &&
            thrown.purpose === "task_links",
        );
        assert.equal(error.mock.callCount(), 0);
        assert.equal(
          await findConsolidationRecord(owner, evaluationCacheKey(input)),
          null,
        );
        error.mock.restore();
      },
    );

    await t.test(
      "provider failures are logged under the caller's event without text",
      async () => {
        const input = request("Private task text");
        const error = t.mock.method(console, "error", () => {});
        await assert.rejects(
          evaluatePersisted(
            owner,
            "provider-run",
            input,
            (async () => {
              throw new GatewayRequestError("AI Gateway returned HTTP 503.", {
                retryable: true,
                status: 503,
              });
            }) as GatewayCall,
            { logEvent: "task_links.evaluation_error" },
          ),
          GatewayRequestError,
        );
        assert.equal(error.mock.callCount(), 1);
        const [event, details] = error.mock.calls[0].arguments;
        assert.equal(event, "task_links.evaluation_error");
        assert.equal(
          (details as { stage: string }).stage,
          "evaluation_provider",
        );
        assert.doesNotMatch(JSON.stringify(details), /Private task text/);
        error.mock.restore();
        const fallback = t.mock.method(console, "error", () => {});
        await assert.rejects(
          evaluatePersisted(owner, "provider-run", input, (async () => {
            throw new GatewayRequestError("AI Gateway returned HTTP 503.", {
              retryable: true,
              status: 503,
            });
          }) as GatewayCall),
        );
        assert.equal(
          fallback.mock.calls[0].arguments[0],
          "consolidation.evaluation_error",
        );
        fallback.mock.restore();
      },
    );
  },
);
