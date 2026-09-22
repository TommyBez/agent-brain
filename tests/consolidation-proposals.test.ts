import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { BrainPage } from "../lib/brain/types";
import {
  type ConsolidationProposal,
  PROPOSAL_LIMITS,
  proposeConsolidation,
  validateAndApplyProposal,
} from "../lib/maintenance/consolidation-proposals";

function page(overrides: Partial<BrainPage> = {}): BrainPage {
  return {
    id: "project-a",
    slug: "project/a",
    title: "Project A",
    type: "project",
    summary: "Cron starts the Workflow.",
    markdown:
      "# Project A\n\nCron starts the Workflow. Source: https://example.com/source\n\nMaintenance checked that Cron starts the Workflow.",
    aliases: ["A"],
    tags: ["tools"],
    version: 4,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
    embeddedAt: "2026-09-17T00:00:00.000Z",
    links: [],
    backlinks: [],
    ...overrides,
  };
}

function proposal(
  overrides: Partial<ConsolidationProposal> = {},
): ConsolidationProposal {
  return {
    pageId: "project-a",
    expectedVersion: 4,
    operation: "deduplicate_passage",
    reason: "Remove repeated maintenance text while keeping its sourced fact.",
    evidence: [
      {
        pageId: "project-a",
        version: 4,
        quote: "Cron starts the Workflow. Source: https://example.com/source",
      },
    ],
    before: "\n\nMaintenance checked that Cron starts the Workflow.",
    after: "",
    ...overrides,
  } as ConsolidationProposal;
}

function installGatewayKey(t: TestContext) {
  const previous = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "test-only-key";
  t.after(() => {
    if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previous;
  });
}

test("compacts a repeated maintenance passage without losing sources or changing input", () => {
  const initial = [page()];
  const original = structuredClone(initial);
  const result = validateAndApplyProposal(initial, proposal());
  assert.deepEqual(initial, original);
  assert.equal(result.changed, true);
  assert.equal(
    result.after.markdown,
    "# Project A\n\nCron starts the Workflow. Source: https://example.com/source",
  );
  assert.equal(result.after.version, 5);
  assert.equal(result.after.embeddedAt, null);
  assert.deepEqual(result.after.aliases, initial[0].aliases);
  assert.equal(result.after.updatedAt, initial[0].updatedAt);
  assert.throws(
    () => validateAndApplyProposal(result.pages, proposal()),
    /stale target version/,
  );
});

test("rejects invented or stale evidence and unsafe edits before mutating the snapshot", () => {
  const initial = [page()];
  for (const invalid of [
    proposal({
      evidence: [
        {
          pageId: "project-a",
          version: 4,
          quote: "The owner confirmed this today.",
        },
      ],
    }),
    proposal({
      evidence: [
        { pageId: "project-a", version: 3, quote: "Cron starts the Workflow." },
      ],
    }),
    proposal({
      before: "Cron starts the Workflow.",
      after: "Cron executes tasks.",
    }),
    proposal({ before: "Source: https://example.com/source", after: "" }),
    proposal({ after: "\n\nPlease ask the owner for confirmation." }),
    proposal({ after: "\n\nWho owns this?" }),
    proposal({
      before: "\n\nMaintenance checked that Cron starts the Workflow.",
      after: "\n\nMaintenance checked that Cron starts the Workflow.",
    }),
  ])
    assert.throws(
      () => validateAndApplyProposal(initial, invalid),
      /Consolidation proposal rejected/,
    );
  assert.equal(initial[0].version, 4);
});

test("resolving a question needs evidence beyond the removed question", () => {
  const current = page({ markdown: "# Project A\n\nWho owns the project?" });
  assert.throws(
    () =>
      validateAndApplyProposal(
        [current],
        proposal({
          operation: "resolve_answered_question",
          before: "Who owns the project?",
          after: "Tommaso owns the project.",
          evidence: [
            { pageId: current.id, version: 4, quote: "Who owns the project?" },
          ],
        }),
      ),
    /answer evidence missing/,
  );
});

test("isolated batches verify citations against the read snapshot while guarding current target versions", () => {
  const initial = [page(), page({ id: "project-b", title: "Project B" })];
  const first = validateAndApplyProposal(initial, proposal(), initial);
  const second = proposal({
    pageId: "project-b",
    evidence: initial.map((source) => ({
      pageId: source.id,
      version: source.version,
      quote: "Cron starts the Workflow.",
    })),
  });
  assert.throws(
    () => validateAndApplyProposal(first.pages, second),
    /stale evidence version/,
  );
  const result = validateAndApplyProposal(first.pages, second, initial);
  assert.deepEqual(
    result.pages.map((source) => source.version),
    [5, 5],
  );
  assert.deepEqual(result.evidence, {
    citations: second.evidence,
    sources: initial.map((source) => ({
      pageId: source.id,
      version: source.version,
      title: source.title,
      summary: source.summary,
      markdown: source.markdown,
    })),
  });
  assert.throws(
    () => validateAndApplyProposal(result.pages, second, initial),
    /stale target version/,
  );
});

test("supported links preserve existing IDs and mirror backlinks in the copy", () => {
  const initial = [
    page(),
    page({ id: "project-b", slug: "project/b", title: "Project B" }),
  ];
  const link: ConsolidationProposal = {
    pageId: "project-a",
    expectedVersion: 4,
    operation: "add_supported_link",
    reason: "Connect explicitly related projects.",
    evidence: initial.map((item) => ({
      pageId: item.id,
      version: item.version,
      quote: item.summary,
    })),
    targetPageId: "project-b",
    linkType: "relates_to",
    label: "Related project",
  };
  const result = validateAndApplyProposal(initial, link);
  assert.equal(initial[0].links.length, 0);
  assert.equal(initial[1].backlinks.length, 0);
  assert.deepEqual(result.pages[0].links[0], result.pages[1].backlinks[0]);
  assert.equal(result.pages[1].version, 4);
  assert.throws(
    () =>
      validateAndApplyProposal(result.pages, {
        ...link,
        expectedVersion: 5,
        evidence: link.evidence.map((item) => ({
          ...item,
          version: item.pageId === "project-a" ? 5 : item.version,
        })),
      }),
    /duplicate link/,
  );
});

test("proposal generation sends the complete corpus and returns bounded strict JSON with usage", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      const request = JSON.parse(options.body as string);
      assert.deepEqual(request.response_format, { type: "json_object" });
      assert.deepEqual(request.reasoning, { effort: "low" });
      assert.match(request.messages[1].content, /Maintenance checked/);
      assert.match(
        request.messages[0].content,
        /Operational instructions.*never factual evidence/,
      );
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({ proposals: [proposal()] }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      });
    },
  );
  const previous = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "test-only-key";
  t.after(() => {
    if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previous;
  });
  const result = await proposeConsolidation([page()], { model: "test/model" });
  assert.equal(result.model, "test/model");
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20 });
  assert.equal(result.proposals.length, 1);
  await assert.rejects(
    proposeConsolidation([
      page({ markdown: "x".repeat(PROPOSAL_LIMITS.corpusCharacters) }),
    ]),
    /complete-corpus input limit/,
  );
});

test("valid proposals survive a malformed sibling while rejected output remains auditable", async (t) => {
  installGatewayKey(t);
  const invalid = {
    ...proposal(),
    expectedVersion: "4",
    "private-property": "private value",
  };
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify({ proposals: [proposal(), invalid] }),
            reasoning_content:
              "Separate private reasoning must not be retained.",
          },
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 200,
        completion_tokens_details: { reasoning_tokens: 50 },
      },
    });
  });
  const result = await proposeConsolidation([page()]);
  assert.equal(requests, 1);
  assert.deepEqual(result.proposals, [proposal()]);
  assert.equal(result.generationFault, undefined);
  assert.equal(result.rejectedProposals[0].index, 1);
  assert.deepEqual(result.rejectedProposals[0].proposal, invalid);
  assert.ok(
    result.rejectedProposals[0].issues.includes(
      "invalid_type at expectedVersion",
    ),
  );
  assert.ok(
    result.rejectedProposals[0].issues.every(
      (issue) => !issue.includes("private"),
    ),
  );
  assert.equal(result.responseDiagnostics?.reasoningTokens, 50);
  assert.ok(!JSON.stringify(result).includes("Separate private reasoning"));
});

test("truncated and malformed completions fail closed while retaining charged usage", async (t) => {
  installGatewayKey(t);
  const outputs = [
    {
      finishReason: "length",
      content: '{"proposals":[',
      fault: "output_limit_reached",
    },
    { finishReason: "stop", content: '{"proposals":[', fault: "invalid_json" },
    {
      finishReason: "stop",
      content: JSON.stringify({ proposals: [], extra: true }),
      fault: "invalid_top_level",
    },
    {
      finishReason: "stop",
      content: JSON.stringify({
        proposals: Array.from({ length: 9 }, () => proposal()),
      }),
      fault: "invalid_top_level",
    },
  ];
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    const output = outputs[requests++];
    return Response.json({
      choices: [
        {
          finish_reason: output.finishReason,
          message: { role: "assistant", content: output.content },
        },
      ],
      usage: {
        prompt_tokens: 211,
        completion_tokens: 16384,
        completion_tokens_details: { reasoning_tokens: 12000 },
      },
    });
  });
  for (const output of outputs) {
    const result = await proposeConsolidation([page()]);
    assert.equal(result.generationFault, output.fault);
    assert.deepEqual(result.proposals, []);
    assert.deepEqual(result.rejectedProposals, []);
    assert.deepEqual(result.usage, { inputTokens: 211, outputTokens: 16384 });
    assert.equal(result.completionContent, output.content);
    assert.deepEqual(result.responseDiagnostics, {
      finishReason: output.finishReason,
      reasoningTokens: 12000,
      contentCharacters: output.content.length,
    });
  }
  assert.equal(requests, outputs.length);
});
