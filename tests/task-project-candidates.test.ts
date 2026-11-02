import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../lib/brain/pages";
import { JEV_MODEL } from "../lib/maintenance/consolidator/jev";
import type { EvaluationRequest } from "../lib/maintenance/consolidator/types";
import { POLICY } from "../lib/maintenance/consolidator/types";
import type { GatewayCall } from "../lib/maintenance/gateway";
import { CANDIDATE_EVALUATION_CONCURRENCY } from "../lib/tasks/evaluate-candidate-pool";
import type {
  CandidatePage,
  TaskLinkSuggestion,
} from "../lib/tasks/link-candidates";
import { createTaskTools } from "../lib/tasks/mcp-tools";
import {
  PROJECT_CANDIDATE_POLICY,
  type ProjectReads,
  projectCandidateReads,
  proposeTaskProject,
} from "../lib/tasks/project-candidates";
import {
  suggestionRequest,
  suggestionRequestKey,
} from "../lib/tasks/suggestion-request";
import { suggestPagesForOwner } from "../lib/workspace/task-link-candidates";
import {
  installServiceDb,
  PAGE_IDS,
  serviceActor,
} from "./helpers/task-service-db";

const draft = {
  title: "Release review",
  description: "Check launch scope",
  projectPageId: null,
};
const page = (id: string): CandidatePage => ({
  id,
  slug: `project/${id}`,
  title: `Project ${id}`,
  markdown: `Scope of ${id}`,
});
const projects = [page("a"), page("b"), page("c")];
const reads: ProjectReads = {
  fullText: async () => projects,
  linkedPages: async () => [projects[0]],
  recentAuthor: async () => [projects[1]],
};
const envelope = (request: EvaluationRequest, probability = 0.9) => ({
  model: JEV_MODEL,
  answers: Object.fromEntries(
    Object.keys(request.questions).map((id) => [
      id,
      { type: "boolean", probability },
    ]),
  ),
});
function sendFake(
  respond: (request: EvaluationRequest) => unknown | Promise<unknown>,
): GatewayCall {
  return (async (path, body) => {
    assert.equal(path, "evaluate");
    const request = body as EvaluationRequest;
    for (const question of Object.values(request.questions))
      assert.equal(question.type, "boolean");
    return respond(request);
  }) as GatewayCall;
}

for (const [name, scores, expected] of [
  [
    "unique project above threshold with sufficient margin is preselected",
    [0.9, 0.7, 0.2],
    "a",
  ],
  [
    "unique project with insufficient runner-up margin is not preselected",
    [0.85, 0.79, 0.2],
    null,
  ],
  ["no project above threshold means no preselection", [0.79, 0.7, 0.2], null],
  [
    "multiple projects above threshold are all shown without preselection",
    [0.9, 0.8, 0.2],
    null,
  ],
] as const) {
  test(name, async () => {
    const result = await proposeTaskProject(
      draft,
      ["context"],
      reads,
      sendFake((request) => ({
        ...envelope(request),
        answers: Object.fromEntries(
          scores.map((score, index) => [
            `project${index}`,
            { type: "boolean", probability: score },
          ]),
        ),
      })),
    );
    assert.equal(result.status, "evaluated");
    assert.equal(result.preselectedProjectRef, expected);
    assert.equal(result.candidates.length, 3);
    assert.deepEqual(
      result.candidates.map((c) => c.score),
      scores,
    );
    assert.ok(
      result.candidates.every((c) => c.reason.startsWith("Active project")),
    );
  });
}

test("out-of-set project ids are discarded through deterministic fallback", async () => {
  const result = await proposeTaskProject(
    draft,
    [],
    reads,
    sendFake((request) => ({
      ...envelope(request),
      answers: {
        ...envelope(request).answers,
        rogue: { type: "boolean", probability: 1 },
      },
    })),
  );
  assert.equal(result.status, "deterministic");
  assert.equal(result.preselectedProjectRef, null);
  assert.deepEqual(
    result.candidates.map((c) => c.projectRef),
    ["a", "b", "c"],
  );
  assert.ok(result.candidates.every((c) => c.score === null));
});

test("project gateway failure or malformed response preserves deterministic source order without preselection", async () => {
  for (const send of [
    sendFake(() => {
      throw new Error("fake unavailable");
    }),
    sendFake((request) => envelope(request, 2)),
  ]) {
    const result = await proposeTaskProject(draft, [], reads, send);
    assert.equal(result.status, "deterministic");
    assert.equal(result.preselectedProjectRef, null);
    assert.deepEqual(
      result.candidates.map((c) => c.projectRef),
      ["a", "b", "c"],
    );
  }
});

test("more than 256 project candidates use bounded parallel boolean batches and enforce K per source", async () => {
  const source = (prefix: string) =>
    Array.from({ length: 140 }, (_, i) => page(`${prefix}${i}`));
  let active = 0;
  let peak = 0;
  let count = 0;
  const result = await proposeTaskProject(
    draft,
    [],
    {
      fullText: async () => source("f"),
      linkedPages: async () => source("l"),
      recentAuthor: async () => source("r"),
    },
    sendFake(async (request) => {
      const size = Object.keys(request.questions).length;
      assert.ok(size <= POLICY.questionsPerRequest);
      assert.ok(JSON.stringify(request).length <= POLICY.evaluationCharacters);
      count += size;
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      return envelope(request);
    }),
  );
  assert.equal(result.candidates.length, 384);
  assert.equal(count, PROJECT_CANDIDATE_POLICY.maxEvaluatedUnits);
  assert.ok(peak <= CANDIDATE_EVALUATION_CONCURRENCY);
  assert.equal(result.unevaluatedProjectRefs?.length, 288);
  assert.equal(active, 0);
});

test("context-aware project batching partitions evidence instead of dropping large candidate pools", async () => {
  let count = 0;
  const fullText = Array.from({ length: 50 }, (_, i) => ({
    ...page(String(i)),
    markdown: "scope ".repeat(1000),
  }));
  const result = await proposeTaskProject(
    draft,
    [],
    {
      fullText: async () => fullText,
      linkedPages: async () => [],
      recentAuthor: async () => [],
    },
    sendFake((request) => {
      assert.ok(JSON.stringify(request).length <= POLICY.evaluationCharacters);
      count += Object.keys(request.questions).length;
      return envelope(request);
    }),
  );
  assert.equal(count, 50);
  assert.equal(result.status, "evaluated");
});

test("all deterministic project sources filter paused projects and scope recent tasks to the author", async () => {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = {
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [] };
    },
  } as unknown as Database;
  const source = projectCandidateReads(db, "owner", "author-agent");
  await source.fullText("launch");
  await source.linkedPages(["page"]);
  await source.recentAuthor();
  assert.equal(queries.length, 3);
  for (const query of queries) {
    assert.match(query.sql, /p.type = 'project'/);
    assert.match(query.sql, /paused_project_ids/);
    assert.doesNotMatch(query.sql, /\b(INSERT|UPDATE|DELETE)\b/);
    assert.equal(query.params[2], 128);
  }
  assert.match(queries[1].sql, /'decided_in', 'relates_to'/);
  assert.match(queries[2].sql, /t.created_by_agent_id = \$2/);
  assert.equal(queries[2].params[1], "author-agent");
  assert.equal(PROJECT_CANDIDATE_POLICY.threshold, 0.8);
  assert.equal(PROJECT_CANDIDATE_POLICY.margin, 0.1);
});

for (const entry of ["MCP", "UI"] as const) {
  test(`${entry} project proposal and recomputation after confirmation stay read-only with zero events`, async (t) => {
    const db = installServiceDb(t, serviceActor("owner"));
    const options = PAGE_IDS.slice(0, 2).map(page);
    const decisions = PAGE_IDS.slice(2).map(page);
    const requestedProjects: unknown[] = [];
    const readsSql: string[] = [];
    t.mock.method(db, "query", async (sql: string, params: unknown[] = []) => {
      readsSql.push(sql);
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|MERGE|CALL)\b/i);
      if (sql.startsWith("SELECT disabled_at"))
        return {
          rows: [{ id: db.actor.agentId, disabled_at: null }],
          rowCount: 1,
        };
      if (sql.includes("FROM brain_consolidation_spend"))
        return { rows: [{ spent_nano: "0", accounts: 1 }], rowCount: 1 };
      if (sql.startsWith("SELECT enabled"))
        return { rows: [{ enabled: true }], rowCount: 1 };
      if (sql.startsWith("SELECT t.id"))
        return {
          rows: [
            {
              title: draft.title,
              description: draft.description,
              project_page_id: null,
              created_by_agent_id: db.actor.agentId,
            },
          ],
          rowCount: 1,
        };
      if (sql.includes("WITH lexical_candidates"))
        return { rows: [], rowCount: 0 };
      if (sql.startsWith("SELECT p.id")) return { rows: options, rowCount: 2 };
      if (sql.startsWith("SELECT id, slug, title, type"))
        return {
          rows: [
            {
              ...options.find((p) => p.id === params[1]),
              type: "project",
              version: 1,
            },
          ],
          rowCount: 1,
        };
      if (sql.includes("SELECT DISTINCT d.id")) {
        requestedProjects.push(params[1]);
        const i = params[1] === options[0].id ? 0 : 1;
        return { rows: [{ id: decisions[i].id, version: 1 }], rowCount: 1 };
      }
      if (sql.startsWith("SELECT id, slug, title,"))
        return {
          rows: decisions.filter((p) => (params[1] as string[]).includes(p.id)),
          rowCount: 1,
        };
      throw new Error("Unexpected read");
    });
    const phases: string[] = [];
    const send = sendFake((request) => {
      const phase = Object.keys(request.questions)[0].startsWith("project")
        ? "projects"
        : "pages";
      phases.push(phase);
      return envelope(request);
    });
    const tool = createTaskTools(send).find(
      (tool) => tool.name === "suggest_task_links",
    );
    assert.ok(tool);
    const call = async (input: unknown) =>
      (entry === "MCP"
        ? tool.handler(db.actor.ownerId, input, {
            ownerId: db.actor.ownerId,
            kind: "token",
            tokenId: "test-token",
            scopes: ["brain:read"],
          })
        : suggestPagesForOwner(
            input,
            async () => ({ id: db.actor.ownerId }),
            send,
          )) as Promise<TaskLinkSuggestion>;
    const initial = await call({ ref: "T-1" });
    assert.equal(initial.kind, "project");
    assert.deepEqual(initial.candidates, []);
    assert.equal(initial.projectProposal?.candidates.length, 2);
    assert.equal(initial.projectProposal?.preselectedProjectRef, null);
    assert.deepEqual(phases, ["projects"]);
    assert.deepEqual(
      requestedProjects,
      [],
      "page decisions must wait for explicit project choice",
    );
    const firstInput = suggestionRequest("T-1", undefined, options[0].id);
    const first = await call(firstInput);
    assert.equal(first.kind, "pages");
    assert.equal(first.projectProposal, undefined);
    assert.deepEqual(
      first.candidates.map((c) => c.pageRef),
      [decisions[0].id],
    );
    const nextInput = suggestionRequest("T-1", undefined, options[1].id);
    assert.notEqual(
      suggestionRequestKey(firstInput),
      suggestionRequestKey(nextInput),
    );
    const next = await call(nextInput);
    assert.equal(next.kind, "pages");
    assert.deepEqual(
      next.candidates.map((c) => c.pageRef),
      [decisions[1].id],
    );
    assert.deepEqual(requestedProjects, [options[0].id, options[1].id]);
    assert.deepEqual(phases, ["projects", "pages", "pages"]);
    assert.deepEqual(db.taskWrites, []);
    assert.deepEqual(db.linkWrites, []);
    assert.deepEqual(db.events, []);
    assert.equal(db.tasks.size, 0);
    assert.equal(db.links.size, 0);
    assert.ok(readsSql.length > 0);
  });
}

test("unmapped agent drafts do not borrow the owner's recent projects", async () => {
  let queries = 0;
  const db = {
    query: async () => {
      queries++;
      return { rows: [] };
    },
  } as unknown as Database;
  assert.deepEqual(
    await projectCandidateReads(db, "owner", null, false).recentAuthor(),
    [],
  );
  assert.equal(queries, 0);
});
