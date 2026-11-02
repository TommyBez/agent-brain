import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Database } from "../lib/brain/pages";
import { JEV_MODEL } from "../lib/maintenance/consolidator/jev";
import {
  type EvaluationRequest,
  POLICY,
} from "../lib/maintenance/consolidator/types";
import {
  type GatewayCall,
  GatewayRequestError,
} from "../lib/maintenance/gateway";
import {
  type CandidateQuestion,
  evaluateCandidatePool,
  truncateCandidateEvidence,
} from "../lib/tasks/evaluate-candidate-pool";
import { evaluateLinkCandidates } from "../lib/tasks/evaluate-link-candidates";
import { TASK_LINK_CANDIDATE_POLICY } from "../lib/tasks/link-candidate-policy";
import {
  findTaskLinkCandidates,
  suggestTaskLinks,
} from "../lib/tasks/link-candidates";
import { readProjectDecisionPageIds } from "../lib/tasks/links";
import {
  suggestionBudgetAvailable,
  withinSuggestionDeadline,
} from "../lib/tasks/suggestion-control";
import {
  installServiceDb,
  PAGE_IDS,
  serviceActor,
} from "./helpers/task-service-db";

const draft = {
  title: "Review",
  description: "Launch evidence",
  projectPageId: "project",
};
const page = (id: string) => ({
  id,
  title: id,
  slug: `note/${id}`,
  markdown: "Head evidence\n".repeat(1000),
});
const candidate = (id: string) => ({
  pageRef: id,
  slug: `note/${id}`,
  title: id,
  role: "context" as const,
  score: 1,
  reason: "Matches the task text",
});
const unit = (id: string): CandidateQuestion => ({
  id,
  evidence: page(id),
  question: { type: "boolean", instructions: `Does pages.${id} help task?` },
});
const answer = (request: EvaluationRequest) => ({
  model: JEV_MODEL,
  answers: Object.fromEntries(
    Object.keys(request.questions).map((id) => [
      id,
      { type: "boolean", probability: 0.9 },
    ]),
  ),
});
function fakeSend(
  fn: (
    r: EvaluationRequest,
    signal?: AbortSignal,
  ) => unknown | Promise<unknown>,
): GatewayCall {
  return (async (path, body, options) => {
    assert.equal(path, "evaluate");
    return fn(body as EvaluationRequest, options?.signal);
  }) as GatewayCall;
}

test("each evidence unit is a head excerpt bounded by the snapshot character policy", async () => {
  const evidence = truncateCandidateEvidence({
    title: "title",
    slug: "note/test",
    markdown: `head${"x".repeat(20_000)}`,
  }) as { title: string; slug: string; markdown: string };
  assert.equal(
    evidence.title.length + evidence.slug.length + evidence.markdown.length,
    POLICY.maxUnitCharacters,
  );
  assert.ok(evidence.markdown.startsWith("head"));
  await evaluateCandidatePool(
    draft,
    "pages",
    [unit("a")],
    fakeSend((r) => {
      const sent = (r.state as { pages: Record<string, typeof evidence> }).pages
        .a;
      assert.ok(
        sent.title.length + sent.slug.length + sent.markdown.length <=
          POLICY.maxUnitCharacters,
      );
      return answer(r);
    }),
  );
});

test("max_tokens repartitions both evidence and questions so smaller states actually succeed", async () => {
  const sizes: number[] = [];
  const result = await evaluateCandidatePool(
    draft,
    "pages",
    [unit("a"), unit("b")],
    fakeSend((r) => {
      const state = r.state as { pages: Record<string, unknown> };
      const n = Object.keys(state.pages).length;
      sizes.push(n);
      assert.deepEqual(Object.keys(state.pages), Object.keys(r.questions));
      if (n > 1)
        throw new GatewayRequestError("fake capacity", {
          reason: "max_tokens_exceeded",
          retryable: false,
        });
      return answer(r);
    }),
  );
  assert.deepEqual(sizes, [2, 1, 1]);
  assert.deepEqual(Object.keys(result), ["a", "b"]);
});

test("one unfit unit is unevaluated while the remaining units still receive JEV judgments", async () => {
  const bad = {
    ...unit("bad"),
    question: {
      type: "boolean" as const,
      instructions: "x".repeat(POLICY.evaluationCharacters),
    },
  };
  const result = await evaluateCandidatePool(
    draft,
    "pages",
    [unit("a"), bad, unit("b")],
    fakeSend(answer),
  );
  assert.equal(result.bad, undefined);
  assert.deepEqual(Object.keys(result).sort(), ["a", "b"]);
});

test("page evaluation drops only unresolvable candidates and preserves deterministic reasons", async () => {
  const result = await evaluateLinkCandidates(
    draft,
    [candidate("gone"), candidate("a")],
    [page("a")],
    fakeSend(answer),
  );
  assert.equal(result.status, "evaluated");
  assert.deepEqual(
    result.candidates.map((c) => c.pageRef),
    ["a"],
  );
  assert.equal(result.candidates[0].reason, candidate("a").reason);
  assert.equal(result.candidates[0].score, 0.9);
});

test("page evaluation cap marks overflow unevaluated instead of returning it as JEV-judged", async () => {
  let n = 0;
  const candidates = Array.from({ length: 60 }, (_, i) => candidate(String(i)));
  const result = await evaluateLinkCandidates(
    draft,
    candidates,
    candidates.map((c) => page(c.pageRef)),
    fakeSend((r) => {
      n += Object.keys(r.questions).length;
      return answer(r);
    }),
  );
  assert.equal(n, TASK_LINK_CANDIDATE_POLICY.maxEvaluatedUnits);
  assert.equal(result.candidates.length, 48);
  assert.equal(result.unevaluatedPageRefs?.length, 12);
});

test("fallback interleaves lexical matches with bounded decisions and the decision read has a SQL limit", async () => {
  const ids = Array.from({ length: 100 }, (_, i) => `d${i}`);
  const result = await findTaskLinkCandidates(
    draft,
    {
      decisions: async () => ids,
      search: async () => [page("text")],
      pages: async (refs) => refs.map(page),
    },
    2,
    fakeSend(() => {
      throw new Error("fake down");
    }),
  );
  assert.equal(result.status, "deterministic");
  assert.deepEqual(
    result.candidates.map((c) => c.pageRef),
    ["d0", "text"],
  );
  const db = {
    query: async (sql: string, args: unknown[]) => {
      assert.match(sql, /LIMIT \$3/);
      assert.equal(args[2], 32);
      return { rows: [{ id: "decision" }] };
    },
  } as unknown as Database;
  assert.deepEqual(await readProjectDecisionPageIds(db, "owner", draft), [
    "decision",
  ]);
});

test("overall suggestion deadline returns deterministic fallback and aborts a nonresponsive fake send", async () => {
  let calls = 0;
  let observed: AbortSignal | undefined;
  const initial = {
    candidates: [candidate("a")],
    status: "deterministic" as const,
    fallbackReason: "deadline" as const,
  };
  const result = await withinSuggestionDeadline(
    initial,
    async (signal, fallback) => {
      const evaluated = await evaluateLinkCandidates(
        draft,
        [candidate("a")],
        [page("a")],
        fakeSend((_r, sentSignal) => {
          calls++;
          observed = sentSignal;
          return new Promise(() => {});
        }),
        { signal, onFallback: (value) => fallback(value as typeof initial) },
      );
      return evaluated as typeof initial;
    },
    15,
  );
  assert.equal(result.status, "deterministic");
  assert.equal(result.fallbackReason, "deadline");
  assert.equal(calls, 1);
  assert.equal(observed?.aborted, true);
});

for (const mode of ["over cap", "budget unreadable"] as const) {
  test(`${mode} skips JEV with deterministic status and no database writes or events`, async (t) => {
    const db = installServiceDb(t, serviceActor("owner"));
    let calls = 0;
    t.mock.method(db, "query", async (sql: string) => {
      assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE)\b/);
      if (sql.includes("FROM brain_consolidation_spend")) {
        if (mode === "budget unreadable") throw new Error("fake read failure");
        return {
          rows: [{ spent_nano: "1000000000", accounts: 1 }],
          rowCount: 1,
        };
      }
      if (sql.startsWith("SELECT t.id"))
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
      if (sql.includes("SELECT DISTINCT d.id"))
        return { rows: [{ id: PAGE_IDS[0] }], rowCount: 1 };
      if (sql.includes("WITH lexical_candidates"))
        return { rows: [], rowCount: 0 };
      if (sql.startsWith("SELECT id, slug, title,"))
        return { rows: [page(PAGE_IDS[0])], rowCount: 1 };
      throw new Error("Unexpected read");
    });
    const result = await suggestTaskLinks(
      db.actor,
      { ref: "T-1" },
      fakeSend((r) => {
        calls++;
        return answer(r);
      }),
    );
    assert.equal(calls, 0);
    assert.equal(result.status, "deterministic");
    assert.equal(
      result.fallbackReason,
      mode === "over cap" ? "budget" : "budget_unavailable",
    );
    assert.equal(result.candidates.length, 1);
    assert.deepEqual(db.taskWrites, []);
    assert.deepEqual(db.linkWrites, []);
    assert.deepEqual(db.events, []);
  });
}

test("budget check uses only SELECT recorded UTC spend against the existing daily cap", async () => {
  for (const spent of [999_999_999, 1_000_000_000]) {
    const db = {
      query: async (sql: string) => {
        assert.match(sql, /^SELECT/);
        assert.match(sql, /sum\(actual_nano\)/);
        assert.match(sql, /AT TIME ZONE 'UTC'/);
        return { rows: [{ spent_nano: String(spent), accounts: 1 }] };
      },
    } as unknown as Database;
    assert.equal(await suggestionBudgetAvailable(db), spent < 1_000_000_000);
  }
});

test("agent guidance documents manual tasks requested suggestions and no automatic task writers", () => {
  const files = [
    "plugins/agent-brain/skills/brain-tasks/SKILL.md",
    "plugins/agent-brain/skills/brain-tasks/references/meetings.md",
    "plugins/agent-brain/skills/brain-tasks/references/lifecycle.md",
    "plugins/agent-brain/skills/brain-memory/references/notes.md",
    "lib/mcp/server.ts",
  ];
  for (const path of files) {
    const content = readFileSync(path, "utf8");
    assert.doesNotMatch(
      content,
      /task keeper|Run now|transcribes explicit/i,
      path,
    );
  }
  assert.match(readFileSync(files[0], "utf8"), /projectProposal/);
  assert.match(
    readFileSync("lib/tasks/tool-definitions.ts", "utf8"),
    /Create tasks for meeting action items or source commitments only when the owner asks you to track one\./,
  );
});

test("a single-unit provider capacity rejection leaves only that unit unevaluated", async () => {
  const answers = await evaluateCandidatePool(
    draft,
    "pages",
    [unit("good"), unit("bad")],
    fakeSend((r) => {
      if (Object.hasOwn(r.questions, "bad"))
        throw new GatewayRequestError("fake capacity", {
          reason: "max_tokens_exceeded",
          retryable: false,
        });
      return answer(r);
    }),
  );
  assert.ok(answers.good);
  assert.equal(answers.bad, undefined);
});
