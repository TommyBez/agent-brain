import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JEV_MODEL } from "../lib/maintenance/consolidator/jev";
import type { EvaluationRequest } from "../lib/maintenance/consolidator/types";
import {
  type GatewayCall,
  GatewayRequestError,
} from "../lib/maintenance/gateway";
import { evaluateLinkCandidates } from "../lib/tasks/evaluate-link-candidates";
import { TASK_LINK_CANDIDATE_POLICY as policy } from "../lib/tasks/link-candidate-policy";
import {
  type CandidatePage,
  findTaskLinkCandidates,
  type PageCandidate,
} from "../lib/tasks/link-candidates";
import { createTaskTools } from "../lib/tasks/mcp-tools";
import { suggestPagesForOwner } from "../lib/workspace/task-link-candidates";
import {
  installServiceDb,
  PAGE_IDS,
  serviceActor,
} from "./helpers/task-service-db";

const draft = {
  title: "Review launch",
  description: "Verify the launch decision",
  projectPageId: "project",
};
const page = (id: string): CandidatePage => ({
  id,
  slug: `note/${id}`,
  title: `Page ${id}`,
  markdown: `Launch evidence ${id}`,
});
const pages = [page("decision"), page("context"), page("other")];
const candidates: PageCandidate[] = pages.map((p, i) => ({
  pageRef: p.id,
  slug: p.slug,
  title: p.title,
  role: i === 0 ? "decision" : "context",
  reason: "deterministic",
  score: 1 / (i + 1),
}));
function sender(respond: (request: EvaluationRequest) => unknown): GatewayCall {
  return (async (path, body) => {
    assert.equal(path, "evaluate");
    assert.equal((body as { model: string }).model, JEV_MODEL);
    return respond(body as EvaluationRequest);
  }) as GatewayCall;
}
const response = (request: EvaluationRequest, score = 0.9) => ({
  model: JEV_MODEL,
  answers: Object.fromEntries(
    Object.keys(request.questions).map((id) => [
      id,
      { type: "boolean", probability: score },
    ]),
  ),
});

test("JEV threshold is inclusive, probability is score and reason comes from the boolean question", async () => {
  let calls = 0;
  const result = await evaluateLinkCandidates(
    draft,
    candidates,
    pages,
    sender((request) => {
      calls++;
      assert.deepEqual((request.state as { task: unknown }).task, {
        title: draft.title,
        description: draft.description,
      });
      assert.ok(JSON.stringify(request.state).includes(pages[0].markdown));
      return {
        model: JEV_MODEL,
        answers: {
          p0: { type: "boolean", probability: policy.threshold - 0.01 },
          p1: { type: "boolean", probability: policy.threshold },
          p2: { type: "boolean", probability: 0.99 },
        },
      };
    }),
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    result.map((c) => [c.pageRef, c.score]),
    [
      ["other", 0.99],
      ["context", policy.threshold],
    ],
  );
  assert.match(
    result[1].reason,
    /Does this page govern or provide useful context/,
  );
});

test("out-of-set JEV answer ids are never returned and trigger deterministic fallback", async () => {
  const result = await evaluateLinkCandidates(
    draft,
    candidates,
    pages,
    sender((request) => ({
      ...response(request),
      answers: {
        ...response(request).answers,
        rogue: { type: "boolean", probability: 1 },
      },
    })),
  );
  assert.deepEqual(result, candidates);
});

test("gateway failure and malformed JEV probabilities fall back to the whole deterministic list", async () => {
  for (const send of [
    sender(() => {
      throw new Error("fake unavailable");
    }),
    sender((request) => response(request, 2)),
  ])
    assert.deepEqual(
      await evaluateLinkCandidates(draft, candidates, pages, send),
      candidates,
    );
});

test("one JEV pass evaluates all decisions and lexical candidates before the output limit", async () => {
  let calls = 0;
  const result = await findTaskLinkCandidates(
    draft,
    {
      decisions: async () => [{ pageId: "decision" }],
      search: async () => pages.slice(1),
      pages: async () => pages,
    },
    1,
    sender((request) => {
      calls++;
      assert.equal(Object.keys(request.questions).length, 3);
      return response(request);
    }),
  );
  assert.equal(calls, 1);
  assert.equal(result.candidates.length, 1);
});

test("JEV batches stay within policy and max_tokens splits reuse evaluateJev", async () => {
  const manyPages = Array.from(
    { length: policy.questionsPerRequest + 1 },
    (_, i) => page(String(i)),
  );
  const many = manyPages.map((p) => ({ ...candidates[0], pageRef: p.id }));
  const sizes: number[] = [];
  const result = await evaluateLinkCandidates(
    draft,
    many,
    manyPages,
    sender((request) => {
      sizes.push(Object.keys(request.questions).length);
      return response(request);
    }),
  );
  assert.deepEqual(sizes, [policy.questionsPerRequest, 1]);
  assert.equal(result.length, many.length);
  const split: number[] = [];
  assert.equal(
    (
      await evaluateLinkCandidates(
        draft,
        candidates,
        pages,
        sender((request) => {
          const count = Object.keys(request.questions).length;
          split.push(count);
          if (count > 1)
            throw new GatewayRequestError("fake capacity", {
              retryable: false,
              reason: "max_tokens_exceeded",
            });
          return response(request);
        }),
      )
    ).length,
    3,
  );
  assert.deepEqual(split, [3, 2, 1, 1, 1]);
});

test("failed later batch discards partial judgments and oversized evidence falls back without sending", async () => {
  const many = Array.from(
    { length: policy.questionsPerRequest + 1 },
    (_, i) => ({ ...candidates[0], pageRef: String(i) }),
  );
  let calls = 0;
  const result = await evaluateLinkCandidates(
    draft,
    many,
    many.map((c) => page(c.pageRef)),
    sender((request) => {
      if (++calls === 2) throw new Error("second batch");
      return response(request);
    }),
  );
  assert.deepEqual(result, many);
  const oversized = pages.map((p) => ({ ...p, markdown: "x".repeat(100_001) }));
  calls = 0;
  assert.deepEqual(
    await evaluateLinkCandidates(
      draft,
      candidates,
      oversized,
      sender((request) => {
        calls++;
        return response(request);
      }),
    ),
    candidates,
  );
  assert.equal(calls, 0);
});

for (const entry of ["MCP tool", "UI action"] as const) {
  test(`${entry} suggestion path with JEV executes only reads and writes zero task rows, links or events`, async (t) => {
    const db = installServiceDb(t, serviceActor("owner"));
    const sql: string[] = [];
    t.mock.method(db, "query", async (statement: string) => {
      sql.push(statement);
      assert.doesNotMatch(statement, /\b(INSERT|UPDATE|DELETE|MERGE|CALL)\b/i);
      if (statement.startsWith("SELECT enabled"))
        return { rows: [{ enabled: true }], rowCount: 1 };
      if (statement.startsWith("SELECT disabled_at"))
        return { rows: [], rowCount: 0 };
      if (statement.startsWith("SELECT t.id"))
        return {
          rows: [
            {
              title: draft.title,
              description: draft.description,
              project_page_id: "project",
            },
          ],
          rowCount: 1,
        };
      if (statement.includes("SELECT DISTINCT d.id"))
        return {
          rows: PAGE_IDS.slice(0, 2).map((id) => ({ id, version: 1 })),
          rowCount: 2,
        };
      if (statement.includes("WITH lexical_candidates"))
        return { rows: [], rowCount: 0 };
      if (statement.startsWith("SELECT id, slug, title, markdown"))
        return { rows: PAGE_IDS.slice(0, 2).map(page), rowCount: 2 };
      throw new Error("Unexpected read query");
    });
    let calls = 0;
    const send = sender((request) => {
      calls++;
      return response(request);
    });
    let result: unknown;
    if (entry === "MCP tool") {
      const tool = createTaskTools(send).find(
        (tool) => tool.name === "suggest_task_links",
      );
      assert.ok(tool);
      assert.equal(tool.scope, "brain:read");
      assert.equal(tool.invalidates, "none");
      result = await tool.handler(
        db.actor.ownerId,
        { ref: "T-1" },
        {
          ownerId: db.actor.ownerId,
          kind: "token",
          tokenId: "test-token",
          scopes: ["brain:read"],
        },
      );
    } else {
      let authorized = 0;
      result = await suggestPagesForOwner(
        { ref: "T-1" },
        async () => {
          authorized++;
          return { id: db.actor.ownerId };
        },
        send,
      );
      assert.equal(authorized, 1);
      const action = readFileSync(
        "app/(workspace)/actions/task-link-candidates.ts",
        "utf8",
      );
      assert.match(
        action,
        /return suggestPagesForOwner\(input, requireWorkspaceUser\)/,
      );
      assert.doesNotMatch(action, /ownerActor|updateTasksCache/);
    }
    assert.equal(calls, 1);
    assert.equal(
      (result as { candidates: PageCandidate[] }).candidates.length,
      2,
    );
    assert.deepEqual(db.taskWrites, []);
    assert.deepEqual(db.linkWrites, []);
    assert.deepEqual(db.events, []);
    assert.ok(sql.length > 0);
  });
}

test("read-only MCP authorization retains owner, credential and disabled-agent checks", async (t) => {
  const db = installServiceDb(t, serviceActor("owner"));
  let evaluations = 0;
  const tool = createTaskTools(
    sender((request) => {
      evaluations++;
      return response(request);
    }),
  ).find((tool) => tool.name === "suggest_task_links");
  assert.ok(tool);
  const call = (principal: import("../lib/auth-principal").Principal) =>
    tool.handler(db.actor.ownerId, { ref: "T-1" }, principal);
  await assert.rejects(
    call({ ownerId: "other-owner", kind: "session", scopes: ["brain:read"] }),
    { code: "forbidden" },
  );
  await assert.rejects(
    call({ ownerId: db.actor.ownerId, kind: "token", scopes: ["brain:read"] }),
    { code: "invalid_token" },
  );
  await assert.rejects(
    call({ ownerId: db.actor.ownerId, kind: "oauth", scopes: ["brain:read"] }),
    { code: "invalid_client" },
  );
  t.mock.method(db, "query", async (sql: string) => {
    assert.match(sql, /^SELECT disabled_at, id FROM brain_agents/);
    return { rows: [{ disabled_at: "2026-11-02" }], rowCount: 1 };
  });
  for (const kind of ["token", "oauth"] as const)
    await assert.rejects(
      call({
        ownerId: db.actor.ownerId,
        kind,
        tokenId: "test-token",
        clientId: "test-client",
        scopes: ["brain:read"],
      }),
      { code: "agent_disabled" },
    );
  assert.equal(evaluations, 0);
  assert.deepEqual(db.taskWrites, []);
  assert.deepEqual(db.linkWrites, []);
  assert.deepEqual(db.events, []);
});

test("UI suggestion action checks session and task enablement before gateway access", async (t) => {
  const db = installServiceDb(t, serviceActor("owner"));
  let evaluations = 0;
  const send = sender((request) => {
    evaluations++;
    return response(request);
  });
  await assert.rejects(
    suggestPagesForOwner(
      {},
      async () => {
        throw new Error("no session");
      },
      send,
    ),
    /no session/,
  );
  t.mock.method(db, "query", async (sql: string) => {
    assert.match(sql, /^SELECT enabled FROM brain_task_settings/);
    return { rows: [{ enabled: false }], rowCount: 1 };
  });
  await assert.rejects(
    suggestPagesForOwner({}, async () => ({ id: db.actor.ownerId }), send),
    { code: "TASKS_DISABLED" },
  );
  assert.equal(evaluations, 0);
  assert.deepEqual(db.taskWrites, []);
  assert.deepEqual(db.linkWrites, []);
  assert.deepEqual(db.events, []);
});

test("valid negative judgments return no candidates; an empty pool never calls JEV", async () => {
  assert.deepEqual(
    await evaluateLinkCandidates(
      draft,
      candidates,
      pages,
      sender((request) => response(request, 0.1)),
    ),
    [],
  );
  let calls = 0;
  assert.deepEqual(
    await evaluateLinkCandidates(
      draft,
      [],
      [],
      sender((request) => {
        calls++;
        return response(request);
      }),
    ),
    [],
  );
  assert.equal(calls, 0);
});
