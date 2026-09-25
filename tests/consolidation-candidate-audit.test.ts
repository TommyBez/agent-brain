import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { BrainPage } from "../lib/brain/types";
import {
  CANDIDATE_POLICY_HASH,
  evaluateCandidate,
} from "../lib/maintenance/consolidation-candidate";
import {
  CANDIDATE_RUN_LIMITS,
  runConsolidationSnapshot,
} from "../lib/maintenance/consolidation-run";
import { KIMI_MODEL } from "../lib/maintenance/kimi-evaluator";
import { auditCandidateArtifacts } from "../scripts/audit-consolidation-candidate";
import { semanticHash } from "../scripts/run-consolidation-candidate";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "candidate-audit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const save = (file: string, value: unknown) =>
    writeFile(join(dir, file), JSON.stringify(value));
  await mkdir(join(dir, "pass-01"));
  const pages: BrainPage[] = ["uno", "due"].map((id) => ({
    id,
    slug: `note/${id}`,
    type: "note",
    title: id,
    summary: "A.",
    markdown: "A.\n\nA.",
    aliases: [],
    tags: [],
    version: 1,
    createdAt: "2026-09-22",
    updatedAt: "2026-09-22",
    embeddedAt: null,
    links: [],
    backlinks: [],
  }));
  const receipt = async <T>(
    key: string,
    input: unknown,
    outcome: T,
  ): Promise<T> => {
    await save(`pass-01/${key}.started.json`, {
      inputHash: hash(input),
      startedAt: "2026-09-22T10:00:00Z",
    });
    await save(`pass-01/${key}.json`, {
      inputHash: hash(input),
      finishedAt: "2026-09-22T10:00:01Z",
      outcome,
    });
    return outcome;
  };
  let index = 0;
  const result = await runConsolidationSnapshot(
    pages,
    { mode: "apply" },
    {
      now: () => 1000,
      generate: (input) =>
        receipt("generation", input, {
          model: "test-generator",
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
          rejectedProposals: [],
          proposals: pages.map((page) => ({
            operation: "deduplicate_passage" as const,
            pageId: page.id,
            expectedVersion: 1,
            reason: "Deduplica.",
            evidence: [{ pageId: page.id, version: 1, quote: "A." }],
            before: page.markdown,
            after: "A.",
          })),
        }),
      evaluate: async (input) =>
        receipt(
          `evaluation-${++index}`,
          input,
          await evaluateCandidate(input, {
            jev: async () => ({
              model: "typesafe-ai/jev",
              usage: { inputTokens: 10, outputTokens: 5, gateway: { cost: 0 } },
              answers: {
                supported_by_evidence: 0.5,
                preserves_distinct_information: 0.01,
                no_new_human_action: 0.01,
                meaningful_improvement: 0.01,
              },
            }),
            kimi: async () => ({
              model: KIMI_MODEL,
              responseId: null,
              responseModel: KIMI_MODEL,
              latencyMs: 1,
              judgments: {
                supported_by_evidence: {
                  verdict: index === 1 ? "pass" : "fail",
                  rationale: "Giudizio della fixture.",
                },
              },
              usage: {
                inputTokens: 10,
                outputTokens: 5,
                totalTokens: 15,
                reasoningTokens: 0,
                cachedInputTokens: 0,
                costUsd: 0.02,
              },
            }),
          }),
        ),
    },
  );
  await save("input.json", { pages });
  await save("protocol.json", {
    preparedAt: "2026-09-22T09:00:00Z",
    mode: "volume",
    passes: 1,
    initialHash: hash(pages),
    invariantHash: null,
    code: {},
    policyHash: CANDIDATE_POLICY_HASH,
    limits: CANDIDATE_RUN_LIMITS,
  });
  const codeHashes = Object.fromEntries(
    await Promise.all(
      ["package.json", "pnpm-lock.yaml"].map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ]),
    ),
  );
  await save("filter.json", {
    frozenAt: "2026-09-22T08:00:00Z",
    contract: { policyHash: CANDIDATE_POLICY_HASH, codeHashes },
  });
  await save("pass-01.json", {
    pass: 1,
    startedAt: "2026-09-22T10:00:00Z",
    finishedAt: "2026-09-22T10:00:01Z",
    elapsedMs: 1000,
    beforeHash: semanticHash(pages),
    afterHash: semanticHash(result.pages),
    changed: true,
    result,
  });
  await save("summary.json", {
    passes: 1,
    appliedToCopy: 1,
    reportedCostUsd: 0.05,
    unknownCostCalls: 0,
    finalSemanticHash: semanticHash(result.pages),
  });
  return { dir, filterProtocol: join(dir, "filter.json") };
}

test("offline audit reproduces raw gray routing, complete sources, rejected history, applied versions and costs", async (t) => {
  const { dir, filterProtocol } = await fixture(t);
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Offline audit must never call a provider.");
  });
  const audited = await auditCandidateArtifacts(dir, { filterProtocol });
  assert.equal(audited.complete, true);
  assert.equal(audited.receiptsChecked, 3);
  assert.deepEqual(audited.rows[0], {
    pass: 1,
    proposed: 2,
    applied: 1,
    jevCalls: 2,
    kimiCalls: 2,
    unresolvedCalls: 0,
    reportedCostUsd: 0.05,
    unknownCostCalls: 0,
    changed: true,
  });
});

test("offline audit rejects an evaluation receipt from a different input even if its copied decision still matches", async (t) => {
  const { dir, filterProtocol } = await fixture(t);
  const path = join(dir, "pass-01/evaluation-1.json");
  const receipt = JSON.parse(await readFile(path, "utf8"));
  receipt.inputHash = "different-input";
  await writeFile(path, JSON.stringify(receipt));
  await assert.rejects(
    auditCandidateArtifacts(dir, { filterProtocol }),
    /Receipt input mismatch/,
  );
});
