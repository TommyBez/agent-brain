import assert from "node:assert/strict";
import test from "node:test";
import type { BrainPage } from "../lib/brain/types";
import { evaluateCandidate } from "../lib/maintenance/consolidation-candidate";
import type { ConsolidationProposal } from "../lib/maintenance/consolidation-proposals";
import { runConsolidationSnapshot } from "../lib/maintenance/consolidation-run";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import { KimiResponseError } from "../lib/maintenance/kimi-evaluator";

const pages: BrainPage[] = ["uno", "due", "tre"].map((id) => ({
  id,
  slug: `project/${id}`,
  title: id,
  type: "project",
  summary: "Fatto.",
  markdown: "# Progetto\n\nFatto.\n\nFatto.",
  aliases: [],
  tags: [],
  version: 1,
  createdAt: "2026-09-22",
  updatedAt: "2026-09-22",
  embeddedAt: null,
  links: [],
  backlinks: [],
}));
function generate(snapshot: BrainPage[]) {
  return Promise.resolve({
    model: "test-generator",
    usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
    rejectedProposals: [],
    proposals: snapshot.map(
      (page): ConsolidationProposal => ({
        pageId: page.id,
        expectedVersion: 1,
        operation: "deduplicate_passage",
        reason: "Rimuove il duplicato.",
        evidence: [{ pageId: page.id, version: 1, quote: "Fatto." }],
        before: "Fatto.\n\nFatto.",
        after: "Fatto.",
      }),
    ),
  });
}
const assess = (
  input: Parameters<typeof evaluateCandidate>[0],
  red = false,
  failures = 0,
) =>
  evaluateCandidate(input, {
    jev: async () => ({
      model: "typesafe-ai/jev",
      usage: { inputTokens: 50, outputTokens: 5, gateway: { cost: 0 } },
      ...(failures
        ? {
            transportFailures: Array.from({ length: failures }, () => ({
              status: 503,
              retryable: true,
              retryAfterMs: null,
            })),
          }
        : {}),
      answers: {
        supported_by_evidence: 0.01,
        preserves_distinct_information: red ? 0.9 : 0.01,
        no_new_human_action: 0.01,
        meaningful_improvement: 0.01,
      },
    }),
    kimi: async () => {
      throw new Error("Kimi must not run for automatic decisions.");
    },
  });

test("new refusal history excludes a prior policy's decision on identical evidence", async () => {
  const deps = {
    generate,
    evaluate: (input: Parameters<typeof evaluateCandidate>[0]) =>
      assess(input, true),
    now: () => 1000,
  };
  const first = await runConsolidationSnapshot(
    pages,
    { mode: "preview" },
    deps,
  );
  const previous = first.report.history.map((item) => ({
    ...item,
    policyHash: "previous-policy",
  }));
  const repeated = await runConsolidationSnapshot(
    pages,
    { mode: "preview", history: previous },
    deps,
  );
  assert.equal(repeated.report.evaluated, 3);
  assert.deepEqual(repeated.report.history, first.report.history);
});

test("recovered Jev failures remain explicit unknown costs for every physical attempt", async () => {
  const result = await runConsolidationSnapshot(
    pages,
    { mode: "apply" },
    { generate, evaluate: (input) => assess(input, false, 2), now: () => 1000 },
  );
  assert.equal(result.report.writes, 2);
  assert.equal(result.report.fault, null);
  assert.equal(result.report.unknownCostCalls, 4);
  assert.equal(result.report.unknownTokenCalls, 4);
  assert.equal(result.report.reportedCostUsd, 0.01);
  assert.equal(result.report.inputTokens, 200);
});

test("a failed second producer stage retains known spend and individual unknown usage", async () => {
  const result = await runConsolidationSnapshot(
    pages,
    { mode: "apply" },
    {
      generate: async (snapshot) => ({
        ...(await generate(snapshot)),
        proposals: [],
        generationFault: "rewrite_http_failure",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          costUsd: 0.01,
          physicalCalls: 2,
          unknownCostCalls: 1,
          unknownTokenCalls: 1,
          inputTokensReported: false,
          outputTokensReported: false,
        },
      }),
      evaluate: async () =>
        assert.fail("Failed generation cannot authorize evaluation or writing"),
      now: () => 1000,
    },
  );
  assert.equal(result.report.writes, 0);
  assert.equal(result.report.unknownCostCalls, 1);
  assert.equal(result.report.unknownTokenCalls, 1);
  assert.equal(result.report.reportedCostUsd, 0.01);
  assert.equal(result.report.inputTokens, 100);
});

test("shared snapshot run applies only accepted proposals, respects two-write budget and preserves preview isolation", async () => {
  const original = structuredClone(pages);
  let evaluated = 0;
  const result = await runConsolidationSnapshot(
    pages,
    { mode: "apply" },
    {
      generate,
      evaluate: async (input) => {
        evaluated++;
        return assess(input);
      },
      now: () => 1000,
    },
  );
  assert.deepEqual(pages, original);
  assert.equal(result.report.writes, 2);
  assert.equal(evaluated, 2);
  assert.equal(result.report.budgetReached, true);
  assert.equal(result.report.persisted, false);
  assert.deepEqual(
    result.pages.map((page) => page.version),
    [2, 2, 1],
  );
  assert.equal(result.report.reportedCostUsd, 0.01);
  assert.equal(result.report.unknownCostCalls, 0);
  const preview = await runConsolidationSnapshot(
    pages,
    {},
    {
      generate,
      evaluate: (input) => assess(input),
      apply: async () => {
        throw new Error("Preview must never call the writer.");
      },
      now: () => 1000,
    },
  );
  assert.equal(preview.report.mode, "preview");
  assert.equal(preview.report.writes, 0);
  assert.deepEqual(preview.pages, original);
  assert.equal(preview.report.entries[0].application, "preview");
});

test("semantic refusals are cached while a technical error stops the run without becoming a cached decision", async () => {
  const refused = await runConsolidationSnapshot(
    pages,
    { mode: "apply" },
    { generate, evaluate: (input) => assess(input, true), now: () => 1000 },
  );
  assert.equal(refused.report.history.length, 3);
  const repeated = await runConsolidationSnapshot(
    pages,
    { mode: "apply", history: refused.report.history },
    {
      generate,
      evaluate: async () => {
        throw new Error(
          "Cached semantic decisions must not be evaluated again.",
        );
      },
      now: () => 1000,
    },
  );
  assert.equal(repeated.report.cached, 3);
  assert.equal(repeated.report.evaluated, 0);
  assert.equal(repeated.report.fault, null);
  assert.equal(repeated.report.history.length, 0);
  let attempts = 0;
  const failed = await runConsolidationSnapshot(
    pages,
    { mode: "apply" },
    {
      generate,
      evaluate: async () => {
        attempts++;
        throw new GatewayRequestError("private-body", {
          retryable: true,
          status: 503,
        });
      },
      now: () => 1000,
    },
  );
  assert.equal(attempts, 1);
  assert.equal(failed.report.fault?.retryable, true);
  assert.equal(failed.report.history.length, 0);
  assert.equal(failed.report.writes, 0);
  assert.ok(!JSON.stringify(failed.report).includes("private-body"));
});

test("composite Kimi support checks preserve per-call unknown usage on success and failure", async () => {
  for (const unavailable of [false, true]) {
    const usage = {
      inputTokens: 40,
      outputTokens: 10,
      totalTokens: 50,
      reasoningTokens: null,
      cachedInputTokens: null,
      costUsd: 0.02,
      physicalCalls: 2,
      unknownCostCalls: 1,
      unknownTokenCalls: 1,
    };
    const result = await runConsolidationSnapshot(
      pages.slice(0, 1),
      { mode: "apply" },
      {
        generate,
        now: () => 1000,
        evaluate: (input) =>
          evaluateCandidate(input, {
            jev: async () => ({
              model: "typesafe-ai/jev",
              usage: { inputTokens: 20, outputTokens: 5, gateway: { cost: 0 } },
              answers: {
                supported_by_evidence: 0.5,
                preserves_distinct_information: 0.01,
                no_new_human_action: 0.01,
                meaningful_improvement: 0.01,
              },
            }),
            kimi: async () => {
              if (unavailable) {
                const failure = new KimiResponseError(
                  "source_challenge",
                  "challenge_unavailable",
                  null,
                  10,
                  usage,
                );
                failure.technicalCause = {
                  kind: "http",
                  status: 503,
                  retryable: true,
                  retryAfterMs: 2000,
                };
                throw failure;
              }
              return {
                model: "moonshotai/kimi-k3",
                responseModel: null,
                responseId: null,
                judgments: {
                  supported_by_evidence: {
                    verdict: "pass",
                    rationale: "Preservato.",
                  },
                },
                latencyMs: 10,
                usage,
              };
            },
          }),
      },
    );
    assert.equal(result.report.writes, unavailable ? 0 : 1);
    assert.equal(result.report.unknownCostCalls, 1);
    assert.equal(result.report.unknownTokenCalls, 1);
    assert.equal(result.report.reportedCostUsd, 0.03);
    assert.equal(result.report.inputTokens, 160);
    assert.equal(result.report.outputTokens, 35);
    assert.equal(result.report.fault !== null, unavailable);
    if (unavailable) {
      assert.equal(result.report.fault?.kind, "http");
      assert.equal(result.report.fault?.status, 503);
      assert.equal(result.report.fault?.retryAfterMs, 2000);
    }
  }
});
