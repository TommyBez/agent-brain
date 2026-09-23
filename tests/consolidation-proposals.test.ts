import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { BrainPage } from "../lib/brain/types";
import {
  createIndexedProposalContext,
  INDEXED_PRODUCER_LIMITS,
} from "../lib/maintenance/consolidation-producer";
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

test("indexed input preserves the full corpus, splits on readable boundaries, and creates exact citations", () => {
  const markdown =
    "# Diario\r\n\r\n" +
    "Una frase documentata. ".repeat(140) +
    "\r\n\r\n" +
    "🧠".repeat(1700) +
    "\n\nUltima fonte.";
  const source = page({ markdown });
  const original = structuredClone(source);
  const context = createIndexedProposalContext([source], 6000);
  assert.equal(
    context.pages[0].markdown.map((part) => part.text).join(""),
    markdown,
  );
  assert.equal(
    context.pages[0].summary.map((part) => part.text).join(""),
    source.summary,
  );
  for (const part of context.pages[0].markdown) {
    assert.ok(part.text.length <= 1200);
    assert.ok(part.text.isWellFormed());
  }
  const last = context.pages[0].markdown.at(-1);
  assert.ok(last);
  const evidence = context.pages[0].summary[0];
  const result = context.materialize({
    operation: "consolidate_passage",
    targetStartId: last.id,
    targetEndId: last.id,
    replacement: "Fonte finale.",
    reason: "Riduzione documentata.",
    evidenceIds: [evidence.id],
  });
  assert.equal(result.before, last.text);
  assert.deepEqual(result.evidence, [
    { pageId: source.id, version: source.version, quote: source.summary },
  ]);
  assert.equal(result.expectedVersion, source.version);
  assert.deepEqual(source, original);
  assert.doesNotThrow(() => createIndexedProposalContext([], 6000));
});

test("indexed ranges can edit later duplicate passages while preserving their unchanged unique context", () => {
  const source = page({
    markdown: `Primo.\n\n${"Fatto A. ".repeat(90)}\n\n${"Fatto A. ".repeat(90)}\n\n# Secondo\n\nFinale.`,
  });
  const context = createIndexedProposalContext([source], 6000);
  const duplicate = context.pages[0].markdown[1];
  const result = context.materialize({
    operation: "deduplicate_passage",
    targetStartId: duplicate.id,
    targetEndId: duplicate.id,
    replacement: "",
    reason: "Elimina un duplicato.",
    evidenceIds: [context.pages[0].markdown[0].id],
  });
  assert.notEqual(
    result.before,
    duplicate.text,
    "context must identify the intended duplicate",
  );
  assert.equal(
    validateAndApplyProposal([source], result).after.markdown,
    `Primo.\n\n${"Fatto A. ".repeat(90)}\n\n \n\n# Secondo\n\nFinale.`,
  );
  assert.ok(result.before.length <= 6000 && result.after.length <= 6000);
});

test("materialization owns paragraph separators before an unchanged heading", () => {
  const source = page({
    markdown:
      "Prima osservazione. Prima osservazione.\r\n\r\n## Dopo\r\n\r\nFatto distinto.",
  });
  const context = createIndexedProposalContext([source], 6000);
  const target = context.pages[0].markdown[0];
  const result = context.materialize({
    operation: "consolidate_passage",
    targetStartId: target.id,
    targetEndId: target.id,
    replacement: "Prima osservazione.",
    reason: "Rimuove la ripetizione.",
    evidenceIds: [target.id],
  });
  assert.equal(
    validateAndApplyProposal([source], result).after.markdown,
    "Prima osservazione.\r\n\r\n## Dopo\r\n\r\nFatto distinto.",
  );
});

test("materialization preserves the space joining a rewritten segment to a sentence suffix", () => {
  const source = page({ markdown: `${"parola ".repeat(200)}chiusura.` });
  const context = createIndexedProposalContext([source], 6000);
  const target = context.pages[0].markdown[0];
  assert.ok(target.text.endsWith(" "));
  const result = context.materialize({
    operation: "consolidate_passage",
    targetStartId: target.id,
    targetEndId: target.id,
    replacement: "Compatto",
    reason: "Rimuove la ripetizione.",
    evidenceIds: [target.id],
  });
  const next = validateAndApplyProposal([source], result).after.markdown;
  assert.ok(next.startsWith("Compatto parola "));
  assert.ok(next.endsWith("chiusura."));
  assert.ok(!next.includes("Compattoparola"));
});

test("indexed endpoints reject invalid ranges and include every interior segment", () => {
  const source = page({
    markdown: ["A", "B", "C", "D", "E", "F", "G", "H", "I"]
      .map((label) => `${label.repeat(700)}.\n\n`)
      .join(""),
  });
  const context = createIndexedProposalContext(
    [source, page({ id: "page-b" })],
    6000,
  );
  const parts = context.pages[0].markdown;
  const selection = {
    operation: "consolidate_passage",
    targetStartId: parts[1].id,
    targetEndId: parts[1].id,
    replacement: "B sintetico.\n\n",
    reason: "Riduzione documentata.",
    evidenceIds: [parts[1].id],
  };
  for (const malformed of [
    { ...selection, targetStartId: "invented" },
    { ...selection, targetEndId: "invented" },
    { ...selection, targetStartId: context.pages[0].summary[0].id },
    { ...selection, targetEndId: context.pages[0].summary[0].id },
    { ...selection, evidenceIds: ["invented"] },
    { ...selection, expectedVersion: 800 },
    { ...selection, evidence: [{ quote: "invented" }] },
    { ...selection, targetStartId: parts[2].id, targetEndId: parts[1].id },
    { ...selection, targetEndId: context.pages[1].markdown[0].id },
    { ...selection, targetStartId: parts[0].id, targetEndId: parts[8].id },
    { ...selection, targetIds: [parts[0].id, parts[2].id] },
    {
      operation: selection.operation,
      targetIds: [parts[0].id, parts[2].id],
      replacement: selection.replacement,
      reason: selection.reason,
      evidenceIds: selection.evidenceIds,
    },
    { ...selection, replacement: "x".repeat(6001) },
  ])
    assert.throws(
      () => context.materialize(malformed),
      /Indexed proposal rejected/,
    );
  const original = structuredClone(source);
  const inclusive = {
    ...selection,
    targetStartId: parts[3].id,
    targetEndId: parts[5].id,
  };
  const { replacement: _replacement, ...rewriteSelection } = inclusive;
  const rewrite = context.rewriteInput(rewriteSelection);
  assert.equal(
    rewrite.before,
    parts
      .slice(3, 6)
      .map((part) => part.text)
      .join(""),
  );
  assert.equal(
    rewrite.immutableContext.prefix +
      rewrite.before +
      rewrite.immutableContext.suffix,
    source.markdown,
  );
  const combined = context.materialize(inclusive);
  assert.deepEqual(source, original);
  assert.equal(combined.before, parts[3].text + parts[4].text + parts[5].text);
  assert.equal(
    validateAndApplyProposal([source], combined).after.markdown,
    parts
      .slice(0, 3)
      .map((part) => part.text)
      .join("") +
      combined.after +
      parts
        .slice(6)
        .map((part) => part.text)
        .join(""),
  );
});

test("complete repeated blocks beyond four segments fit the new bound while passages over 8000 remain invalid", () => {
  const block = (heading: string) =>
    `## ${heading}\n\n${Array.from({ length: 4 }, () => `${"Fatto comune documentato. ".repeat(34)}\n\n`).join("")}`;
  const source = page({ markdown: block("Blocco A") + block("Blocco B") });
  const context = createIndexedProposalContext(
    [source],
    PROPOSAL_LIMITS.passageCharacters,
  );
  const parts = context.pages[0].markdown;
  assert.equal(parts.length, 8);
  assert.ok(source.markdown.length > 6000);
  const selection = {
    operation: "consolidate_passage",
    targetStartId: parts[0].id,
    targetEndId: parts[parts.length - 1].id,
    evidenceIds: parts.map((part) => part.id),
    reason: "Rimuove le ripetizioni comprese in entrambi i blocchi.",
  };
  assert.equal(context.rewriteInput(selection).before, source.markdown);
  const proposal = context.materialize({
    ...selection,
    replacement: "Fatto comune documentato.",
  });
  assert.equal(proposal.before, source.markdown);
  assert.equal(
    validateAndApplyProposal([source], proposal).after.markdown.trim(),
    "Fatto comune documentato.",
  );
  assert.throws(
    () =>
      context.materialize({
        ...selection,
        replacement: "x".repeat(8001),
      }),
    /invalid selection schema/,
  );
  const oversized = createIndexedProposalContext(
    [page({ markdown: "x".repeat(8001) })],
    PROPOSAL_LIMITS.passageCharacters,
  );
  assert.ok(
    oversized.pages[0].markdown.length <=
      INDEXED_PRODUCER_LIMITS.targetSegments,
  );
  assert.throws(
    () =>
      oversized.rewriteInput({
        ...selection,
        targetStartId: oversized.pages[0].markdown[0].id,
        targetEndId:
          oversized.pages[0].markdown[oversized.pages[0].markdown.length - 1]
            .id,
        evidenceIds: [oversized.pages[0].markdown[0].id],
      }),
    /target or replacement exceeds passage limit/,
  );
});

test("candidate generation uses constrained passage IDs and materializes exact evidence", async (t) => {
  installGatewayKey(t);
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    deadlines.push(milliseconds);
    return new AbortController().signal;
  });
  const initial = page({
    markdown: `${"Fatto mantenuto. ".repeat(50)}\n\n${"Nota ripetuta. ".repeat(55)}\n\n${"Ultima informazione. ".repeat(45)}`,
  });
  let calls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      calls++;
      const request = JSON.parse(String(init.body));
      assert.deepEqual(request.reasoning, {
        effort:
          request.response_format.type === "json_object" ? "high" : "none",
      });
      assert.equal(
        request.max_tokens,
        request.response_format.type === "json_object" ? 32_768 : 16_384,
      );
      if (request.response_format.type === "json_object") {
        const input = JSON.parse(request.messages[1].content);
        assert.equal(input.before, `${"Nota ripetuta. ".repeat(55)}\n\n`);
        assert.deepEqual(Object.keys(input).sort(), ["before", "operation"]);
        assert.ok(!request.messages[1].content.includes("Ultima informazione"));
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({ replacement: "" }),
              },
            },
          ],
          usage: { prompt_tokens: 200, completion_tokens: 80, cost: "0.0002" },
        });
      }
      assert.equal(request.response_format.type, "json_schema");
      assert.equal(request.response_format.json_schema.strict, true);
      const indexed = JSON.parse(
        request.messages[1].content.split("\n").slice(1).join("\n"),
      );
      assert.equal(
        indexed[0].markdown.map((part: { text: string }) => part.text).join(""),
        initial.markdown,
      );
      const item = {
        operation: "deduplicate_passage",
        targetStartId: indexed[0].markdown[1].id,
        targetEndId: indexed[0].markdown[1].id,
        reason: "Riduce la ripetizione.",
        evidenceIds: [indexed[0].markdown[0].id],
      };
      const schema =
        request.response_format.json_schema.schema.properties.proposals;
      assert.equal(schema.maxItems, 1);
      assert.equal(schema.items.properties.targetIds, undefined);
      assert.ok(
        schema.items.properties.targetStartId.enum.includes(item.targetStartId),
      );
      assert.ok(
        schema.items.properties.targetEndId.enum.includes(item.targetEndId),
      );
      assert.deepEqual(
        schema.items.properties.targetStartId.enum,
        schema.items.properties.targetEndId.enum,
      );
      assert.ok(schema.items.required.includes("targetStartId"));
      assert.ok(schema.items.required.includes("targetEndId"));
      assert.match(request.messages[0].content, /1–8 consecutive segments/);
      assert.match(request.messages[0].content, /at most 8000 characters/);
      assert.ok(
        schema.items.properties.evidenceIds.items.enum.includes(
          item.evidenceIds[0],
        ),
      );
      assert.equal(schema.items.properties.before, undefined);
      assert.equal(schema.items.properties.replacement, undefined);
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                proposals: [item],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 200, completion_tokens: 80, cost: "0.0002" },
      });
    },
  );
  const result = await proposeConsolidation([initial], {
    scope: "candidate-v1",
  });
  assert.equal(calls, 2);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].pageId, initial.id);
  assert.equal(
    "before" in result.proposals[0] && result.proposals[0].before,
    `${"Nota ripetuta. ".repeat(55)}\n\n`,
  );
  assert.deepEqual(result.proposals[0].evidence, [
    {
      pageId: initial.id,
      version: initial.version,
      quote: `${"Fatto mantenuto. ".repeat(50)}\n\n`,
    },
  ]);
  assert.equal(result.rejectedProposals.length, 0);
  assert.equal(result.usage.costUsd, 0.0004);
  assert.equal(result.usage.physicalCalls, 2);
  assert.deepEqual(deadlines, [120_000, 180_000]);
  assert.equal(result.usage.unknownCostCalls, 0);
});

test("a failed rewrite retains the paid selection receipt and counts unknown usage once", async (t) => {
  installGatewayKey(t);
  let calls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      calls++;
      if (calls === 2)
        return new Response("private provider error", { status: 503 });
      assert.equal(calls, 1);
      const body = JSON.parse(String(init.body));
      const input = JSON.parse(
        body.messages[1].content.split("\n").slice(1).join("\n"),
      );
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                proposals: input
                  .slice(0, 1)
                  .map((p: { markdown: { id: string }[] }) => ({
                    operation: "consolidate_passage",
                    targetStartId: p.markdown[0].id,
                    targetEndId: p.markdown[0].id,
                    reason: "Compact repetition.",
                    evidenceIds: [p.markdown[0].id],
                  })),
              }),
              reasoning_content: "Not retained.",
            },
          },
        ],
        usage: { prompt_tokens: 101, completion_tokens: 50, cost: 0.00011 },
      });
    },
  );
  const result = await proposeConsolidation([page(), page({ id: "page-b" })], {
    scope: "candidate-v1",
  });
  assert.equal(result.generationFault, "rewrite_request_failed");
  assert.deepEqual(result.proposals, []);
  assert.equal(calls, 2);
  assert.deepEqual(result.usage, {
    inputTokens: 101,
    outputTokens: 50,
    costUsd: 0.00011,
    inputTokensReported: false,
    outputTokensReported: false,
    physicalCalls: 2,
    unknownCostCalls: 1,
    unknownTokenCalls: 1,
  });
  assert.equal(result.generationStages?.[1].error?.status, 503);
  assert.ok(!JSON.stringify(result).includes("private provider error"));
  assert.ok(!JSON.stringify(result).includes("Not retained"));
});

test("an over-cap paid selection fails closed before any rewrite", async (t) => {
  installGatewayKey(t);
  let calls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init.body));
      const pages = JSON.parse(
        body.messages[1].content.split("\n").slice(1).join("\n"),
      );
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                proposals: pages.map((p: { markdown: { id: string }[] }) => ({
                  operation: "consolidate_passage",
                  targetStartId: p.markdown[0].id,
                  targetEndId: p.markdown[0].id,
                  reason: "Compact repetition.",
                  evidenceIds: [p.markdown[0].id],
                })),
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, cost: "0.0001" },
      });
    },
  );
  const result = await proposeConsolidation([page(), page({ id: "page-b" })], {
    scope: "candidate-v1",
  });
  assert.equal(calls, 1);
  assert.equal(result.generationFault, "selection_invalid_top_level");
  assert.deepEqual(result.proposals, []);
  assert.equal(result.usage.physicalCalls, 1);
  assert.equal(result.usage.costUsd, 0.0001);
});

test("null and unchanged rewrites abstain while retaining provider identity and paid usage", async (t) => {
  installGatewayKey(t);
  let calls = 0;
  let sameText = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init.body));
      const content =
        calls % 2 === 1
          ? {
              proposals: JSON.parse(
                body.messages[1].content.split("\n").slice(1).join("\n"),
              ).map((p: { markdown: { id: string }[] }) => ({
                operation: "consolidate_passage",
                targetStartId: p.markdown[0].id,
                targetEndId: p.markdown[0].id,
                reason: "Compact repetition.",
                evidenceIds: [p.markdown[0].id],
              })),
            }
          : {
              replacement: sameText
                ? JSON.parse(body.messages[1].content).before
                : null,
            };
      return Response.json({
        model: "provider-returned-model",
        id: `response-${calls}`,
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify(content) },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, cost: "0.0001" },
      });
    },
  );
  for (const unchanged of [false, true]) {
    sameText = unchanged;
    const result = await proposeConsolidation([page()], {
      scope: "candidate-v1",
    });
    assert.equal(result.generationFault, undefined);
    assert.deepEqual(result.proposals, []);
    assert.deepEqual(result.rejectedProposals, []);
    assert.equal(result.usage.physicalCalls, 2);
    assert.equal(result.usage.costUsd, 0.0002);
    assert.deepEqual(
      result.generationStages?.map((stage) => [
        stage.responseModel,
        stage.abstained ?? false,
      ]),
      [
        ["provider-returned-model", false],
        ["provider-returned-model", true],
      ],
    );
    assert.equal(result.generationStages?.[1].responseId, `response-${calls}`);
  }
});
