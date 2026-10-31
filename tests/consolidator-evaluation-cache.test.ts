import assert from "node:assert/strict";
import test from "node:test";
import { getPool } from "../lib/db";
import {
  evaluatePersisted,
  evaluationCacheKey,
} from "../lib/maintenance/consolidator/evaluation-cache";
import { JEV_MODEL } from "../lib/maintenance/consolidator/jev";
import type { EvaluationRequest } from "../lib/maintenance/consolidator/types";
import {
  type GatewayCall,
  GatewayRequestError,
} from "../lib/maintenance/gateway";

test("a later split failure preserves successful evaluations for a subsequent run", async (t) => {
  const oldUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://unused:unused@localhost/unused";
  const pool = getPool();
  t.after(async () => {
    if (oldUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldUrl;
    await pool.end();
  });
  // No connection is opened: this test exercises the persisted evaluator with
  // an in-memory substitute only for the database transport.
  const saved = new Map<string, unknown>();
  t.mock.method(pool, "query", async (sql: string, values: string[]) => {
    const [owner, keyOrRun, key, payload] = values;
    if (sql.startsWith("INSERT INTO brain_consolidation_records")) {
      saved.set(`${owner}:${key}`, JSON.parse(payload));
      return { rows: [{ record_key: key }], rowCount: 1 };
    }
    assert.match(sql, /^SELECT payload FROM brain_consolidation_records/);
    const value = saved.get(`${owner}:${keyOrRun}`);
    return { rows: value ? [{ payload: value }] : [], rowCount: value ? 1 : 0 };
  });
  t.mock.method(console, "error", () => {});
  const question = {
    type: "boolean" as const,
    instructions: "Is the fact documented?",
    criteria: { true: "Documented", false: "Absent" },
  };
  const request: EvaluationRequest = {
    state: { text: "Complete source evidence." },
    questions: { a: question, b: question },
  };
  let failSecond = true;
  const calls: string[] = [];
  const send: GatewayCall = async <T>(_path: string, body: unknown) => {
    const sent = body as EvaluationRequest;
    assert.deepEqual(sent.state, request.state);
    const ids = Object.keys(sent.questions);
    calls.push(ids.join(","));
    if (ids.length > 1 || (ids[0] === "b" && failSecond))
      throw new GatewayRequestError("Capacity limit", {
        retryable: false,
        reason: "max_tokens_exceeded",
      });
    return {
      model: JEV_MODEL,
      answers: { [ids[0]]: { type: "boolean", probability: 0.9 } },
      usage: { inputTokens: 10, outputTokens: 1 },
    } as T;
  };
  await assert.rejects(evaluatePersisted("owner", "run-1", request, send));
  assert.deepEqual(calls, ["a,b", "a", "b"]);
  assert.equal(saved.has(`owner:${evaluationCacheKey(request)}`), false);
  failSecond = false;
  calls.length = 0;
  const result = await evaluatePersisted("owner", "run-2", request, send);
  assert.deepEqual(calls, ["a,b", "b"]);
  assert.deepEqual(Object.keys(result.answers), ["a", "b"]);
  assert.equal(result.inputTokens, 20);
  calls.length = 0;
  assert.deepEqual(
    await evaluatePersisted("owner", "run-3", request, send),
    result,
  );
  assert.deepEqual(calls, []);
});
