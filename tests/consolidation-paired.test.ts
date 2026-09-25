import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BrainPage } from "../lib/brain/types";
import type { proposeConsolidation } from "../lib/maintenance/consolidation-proposals";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import { JEV_CONSOLIDATION_THRESHOLDS } from "../lib/maintenance/jev";
import {
  assistantReviewSchema,
  runPairedExperiment,
} from "../scripts/evaluate-consolidation-paired";

function page(id: string): BrainPage {
  return {
    id,
    slug: `note/${id}`,
    title: id,
    type: "note",
    summary: "Brain uses PostgreSQL.",
    markdown: "Brain uses PostgreSQL. Brain uses PostgreSQL.",
    aliases: [],
    tags: [],
    version: 1,
    createdAt: "2026-09-17T00:00:00Z",
    updatedAt: "2026-09-17T00:00:00Z",
    embeddedAt: null,
    links: [],
    backlinks: [],
  };
}
function generation(
  pages: BrainPage[],
): Awaited<ReturnType<typeof proposeConsolidation>> {
  return {
    proposals: pages.map((item) => ({
      operation: "deduplicate_passage",
      pageId: item.id,
      expectedVersion: item.version,
      reason: "Remove exact repetition.",
      before: item.markdown,
      after: "Brain uses PostgreSQL.",
      evidence: [
        { pageId: item.id, version: item.version, quote: item.markdown },
      ],
    })),
    rejectedProposals: [],
    model: "test-model",
    usage: { inputTokens: 10, outputTokens: 10 },
  };
}
function evaluation() {
  return {
    answers: Object.fromEntries(
      Object.keys(JEV_CONSOLIDATION_THRESHOLDS).map((criterion) => [
        criterion,
        0.99,
      ]),
    ),
    usage: { inputTokens: 20, outputTokens: 0 },
    model: "test-jev",
  };
}
async function fixture(count = 1) {
  const output = await mkdtemp(join(tmpdir(), "brain-paired-test-"));
  const snapshot = join(output, "initial.json");
  await writeFile(
    snapshot,
    JSON.stringify({
      capturedAt: "2026-09-17T00:00:00Z",
      pages: Array.from({ length: count }, (_, index) =>
        page(String(index + 1)),
      ),
    }),
  );
  await writeFile(
    join(output, "evaluation-spec.json"),
    JSON.stringify({ test: true }),
  );
  return { output, snapshot, passes: 1, model: "test-model" };
}
async function review(output: string) {
  const request = JSON.parse(
    await readFile(join(output, "blind-request-01.json"), "utf8"),
  );
  return assistantReviewSchema.parse({
    pass: 1,
    reviewer: "assistant",
    candidates: request.candidates.map(
      (candidate: { candidateId: string; inputHash: string }) => ({
        candidateId: candidate.candidateId,
        inputHash: candidate.inputHash,
        familyId: "exact-duplicate",
        criteria: Object.fromEntries(
          Object.keys(JEV_CONSOLIDATION_THRESHOLDS).map((criterion) => [
            criterion,
            {
              verdict: "pass",
              rationale: "The duplicate fact survives unchanged.",
            },
          ]),
        ),
      }),
    ),
  });
}
async function writeReview(output: string, value: unknown) {
  await writeFile(
    join(output, "assistant-review-01.json"),
    JSON.stringify(value),
  );
}

test("paired runner freezes complete blind reviews before Jev and keeps assistant labels in shadow", async () => {
  const options = await fixture();
  let generated = 0;
  let evaluated = 0;
  const dependencies = {
    propose: async (pages: BrainPage[]) => {
      generated++;
      return generation(pages);
    },
    evaluate: async () => {
      evaluated++;
      const frozen = JSON.parse(
        await readFile(join(options.output, "review-frozen-01.json"), "utf8"),
      );
      assert.match(frozen.reviewHash, /^[a-f0-9]{64}$/);
      return evaluation();
    },
  };
  try {
    const pending = await runPairedExperiment(options, dependencies);
    assert.equal(pending.status, "awaiting_review");
    assert.equal(generated, 1);
    assert.equal(evaluated, 0);
    const assistant = await review(options.output);
    assistant.candidates[0].criteria.meaningful_improvement.verdict =
      "uncertain";
    await writeReview(options.output, assistant);
    const completed = await runPairedExperiment(options, dependencies);
    assert.equal(completed.status, "completed");
    if (completed.status !== "completed")
      throw new Error("Expected complete run.");
    assert.equal(completed.applied, 1);
    assert.equal(completed.assistantWouldPass, 0);
    assert.equal(generated, 1);
    assert.equal(evaluated, 1);
    await runPairedExperiment(options, dependencies);
    assert.equal(generated, 1);
    assert.equal(evaluated, 1);
    assistant.candidates[0].criteria.meaningful_improvement.verdict = "pass";
    await writeReview(options.output, assistant);
    await assert.rejects(
      runPairedExperiment(options, dependencies),
      /frozen assistant review/,
    );
    assert.equal(evaluated, 1);
  } finally {
    await rm(options.output, { recursive: true, force: true });
  }
});

test("reviews with missing candidates, wrong hashes, duplicate IDs or unknown criteria cannot reach Jev", async () => {
  const options = await fixture(2);
  let evaluated = 0;
  const dependencies = {
    propose: async (pages: BrainPage[]) => generation(pages),
    evaluate: async () => {
      evaluated++;
      return evaluation();
    },
  };
  try {
    await runPairedExperiment(options, dependencies);
    const assistant = await review(options.output);
    for (const mutate of [
      (value: typeof assistant) => {
        value.candidates.pop();
      },
      (value: typeof assistant) => {
        value.candidates[0].inputHash = "0".repeat(64);
      },
      (value: typeof assistant) => {
        value.candidates[1] = value.candidates[0];
      },
      (value: typeof assistant) => {
        Object.assign(value.candidates[0].criteria, {
          extra: { verdict: "pass", rationale: "Extra." },
        });
      },
    ]) {
      const invalid = structuredClone(assistant);
      mutate(invalid);
      await writeReview(options.output, invalid);
      await assert.rejects(runPairedExperiment(options, dependencies));
      assert.equal(evaluated, 0);
    }
  } finally {
    await rm(options.output, { recursive: true, force: true });
  }
});

test("partial provider failure resumes from saved evaluations without paid duplicate or state loss", async () => {
  const options = await fixture(2);
  let evaluated = 0;
  let failSecond = true;
  const dependencies = {
    propose: async (pages: BrainPage[]) => generation(pages),
    evaluate: async () => {
      evaluated++;
      if (evaluated === 2 && failSecond)
        throw new GatewayRequestError("Provider failed.", { retryable: false });
      return evaluation();
    },
  };
  try {
    await runPairedExperiment(options, dependencies);
    await writeReview(options.output, await review(options.output));
    await assert.rejects(
      runPairedExperiment(options, dependencies),
      /Provider failed/,
    );
    assert.equal(evaluated, 2);
    failSecond = false;
    const completed = await runPairedExperiment(options, dependencies);
    assert.equal(completed.status, "completed");
    if (completed.status !== "completed")
      throw new Error("Expected complete run.");
    assert.equal(completed.applied, 2);
    assert.equal(evaluated, 3);
    const final = JSON.parse(
      await readFile(join(options.output, "final.json"), "utf8"),
    );
    assert.ok(
      final.pages.every(
        (item: BrainPage) => item.markdown === "Brain uses PostgreSQL.",
      ),
    );
  } finally {
    await rm(options.output, { recursive: true, force: true });
  }
});
