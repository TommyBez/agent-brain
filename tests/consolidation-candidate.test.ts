import assert from "node:assert/strict";
import test from "node:test";
import type { BrainPage } from "../lib/brain/types";
import {
  CANDIDATE_POLICY_HASH,
  evaluateCandidate,
  prepareCandidateProposal,
} from "../lib/maintenance/consolidation-candidate";
import {
  type ConsolidationProposal,
  proposeConsolidation,
} from "../lib/maintenance/consolidation-proposals";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import type { ConsolidationEvaluation } from "../lib/maintenance/jev";
import {
  KIMI_MODEL,
  type KimiEvaluation,
} from "../lib/maintenance/kimi-evaluator";

const page: BrainPage = {
  id: "project-a",
  slug: "project/a",
  title: "Progetto A",
  type: "project",
  summary: "Sara è proprietaria.",
  aliases: [],
  tags: [],
  version: 4,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-09-22T00:00:00.000Z",
  embeddedAt: null,
  links: [],
  backlinks: [],
  markdown:
    "Sara è proprietaria. [Fonte](../fonti/verbale_(finale).md).\n\nSara è proprietaria. [Fonte](../fonti/verbale_(finale).md).\n\n[Verbale][verbale]\n\n[verbale]: ../fonti/verbale.md",
};
const proposal: ConsolidationProposal = {
  pageId: page.id,
  expectedVersion: 4,
  operation: "deduplicate_passage",
  reason: "Eliminare la ripetizione mantenendo il fatto e i collegamenti.",
  evidence: [{ pageId: page.id, version: 4, quote: "Sara è proprietaria." }],
  before: "\n\nSara è proprietaria. [Fonte](../fonti/verbale_(finale).md).",
  after: "",
};
const jev: ConsolidationEvaluation = {
  model: "typesafe-ai/jev",
  usage: {},
  answers: {
    supported_by_evidence: 0.12,
    preserves_distinct_information: 0.1,
    no_new_human_action: 0.1,
    meaningful_improvement: 0.01,
  },
};
function kimi(verdict: "pass" | "uncertain"): KimiEvaluation {
  return {
    model: KIMI_MODEL,
    responseModel: KIMI_MODEL,
    responseId: null,
    latencyMs: 1,
    judgments: {
      supported_by_evidence: {
        verdict,
        rationale: "La fonte attribuisce la proprietà a Sara.",
      },
    },
    usage: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      reasoningTokens: null,
      cachedInputTokens: null,
      costUsd: null,
    },
  };
}

test("candidate prepares a complete immutable snapshot, retains duplicate relative links and delegates only gray criteria", async (t) => {
  const sources = [
    structuredClone(page),
    {
      ...structuredClone(page),
      id: "evidence-b",
      markdown: "Una precisazione non citata nella proposta.",
      version: 2,
    },
  ];
  const original = structuredClone(sources);
  const prepared = prepareCandidateProposal(sources, proposal);
  assert.deepEqual(sources, original);
  assert.equal(prepared.nextPage.version, 5);
  assert.equal(
    prepared.nextPage.markdown.match(/Sara è proprietaria/g)?.length,
    1,
  );
  assert.match(
    JSON.stringify(prepared.input.evidence),
    /Una precisazione non citata/,
  );
  const result = await evaluateCandidate(
    { ...prepared.input, ...{ expectedDecision: "FORBIDDEN" } },
    {
      jev: async (input) => {
        assert.deepEqual(input, prepared.input);
        return structuredClone(jev);
      },
      kimi: async (input, selected) => {
        assert.deepEqual(input, prepared.input);
        assert.deepEqual(selected, ["supported_by_evidence"]);
        return kimi("pass");
      },
    },
  );
  assert.equal(result.policyHash, CANDIDATE_POLICY_HASH);
  assert.equal(result.finalDecision, "accept");
  assert.equal(result.route, "defer");
  assert.deepEqual(Object.values(result.finalCriteria), [
    "pass",
    "pass",
    "pass",
    "pass",
  ]);

  const previousKey = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "test-only";
  t.after(() => {
    if (previousKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previousKey;
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      assert.deepEqual(request.reasoning, {
        effort:
          request.response_format.type === "json_object" ? "high" : "none",
      });
      assert.equal(request.max_tokens, 16_384);
      if (request.response_format.type === "json_object") {
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  replacement: prepared.nextPage.markdown,
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        });
      }
      assert.match(
        request.messages[0].content,
        /operation \(deduplicate_passage, consolidate_passage, resolve_answered_question\)/,
      );
      assert.doesNotMatch(request.messages[0].content, /For refresh_summary/);
      assert.match(request.messages[0].content, /at most one proposal/);
      assert.equal(request.response_format.type, "json_schema");
      assert.equal(request.response_format.json_schema.strict, true);
      const indexed = JSON.parse(
        request.messages[1].content.split("\n").slice(1).join("\n"),
      );
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                proposals: [
                  {
                    operation: proposal.operation,
                    targetIds: [indexed[0].markdown[0].id],
                    reason: proposal.reason,
                    evidenceIds: [indexed[0].summary[0].id],
                  },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      });
    },
  );
  const generated = (
    await proposeConsolidation(sources, { scope: "candidate-v1" })
  ).proposals;
  assert.equal(generated.length, 1);
  assert.equal(
    prepareCandidateProposal(sources, generated[0]).nextPage.markdown,
    prepared.nextPage.markdown,
  );
});

test("candidate fails closed on a removed relative link, a red criterion, uncertainty and transport failure", async () => {
  const referenceRemoval = {
    ...proposal,
    before: "[Verbale][verbale]\n\n",
    after: "",
  };
  assert.throws(
    () => prepareCandidateProposal([page], referenceRemoval),
    /Markdown link removal/,
  );
  assert.throws(
    () =>
      prepareCandidateProposal([page], {
        ...proposal,
        operation: "refresh_summary",
        before: page.summary,
        after: "Nuovo riepilogo.",
      }),
    /outside candidate scope/,
  );
  const input = prepareCandidateProposal([page], proposal).input;
  const red = await evaluateCandidate(input, {
    jev: async () => ({
      ...jev,
      answers: { ...jev.answers, preserves_distinct_information: 0.79 },
    }),
    kimi: async () => {
      throw new Error("Kimi must not run after a red criterion.");
    },
  });
  assert.equal(red.finalDecision, "reject");
  assert.equal(red.finalCriteria.supported_by_evidence, "not_evaluated");
  assert.equal(red.kimi, null);
  const uncertain = await evaluateCandidate(input, {
    jev: async () => jev,
    kimi: async () => kimi("uncertain"),
  });
  assert.equal(uncertain.finalDecision, "uncertain");
  const failed = await evaluateCandidate(input, {
    jev: async () => jev,
    kimi: async () => {
      throw new GatewayRequestError("Private provider text", {
        retryable: true,
        status: 503,
      });
    },
  });
  assert.equal(failed.finalDecision, "error");
  assert.equal(failed.kimi?.status, "error");
  assert.ok(!JSON.stringify(failed).includes("Private provider text"));
});
