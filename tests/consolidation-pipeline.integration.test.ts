import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { EMBEDDING_DIMENSIONS } from "../lib/brain/schemas";
import * as brain from "../lib/brain/service";
import type { BrainPage } from "../lib/brain/types";
import { getPool } from "../lib/db";
import { evaluateCandidate } from "../lib/maintenance/consolidation-candidate";
import type { ConsolidationProposal } from "../lib/maintenance/consolidation-proposals";
import { runConsolidationSnapshot } from "../lib/maintenance/consolidation-run";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import { exportBrainToGitHub } from "../lib/maintenance/github-export";
import {
  beginWorkflowJob,
  dailyWorkflowStatus,
  finishWorkflowJob,
  queueWorkflowJobs,
  workflowExportAttemptKey,
} from "../lib/maintenance/jobs";
import { exportBrain } from "../lib/operations";
import { indexPageFixture } from "./helpers/brain-embeddings";
import { GitHub, repository, required } from "./helpers/github-export";

const runDate = "2026-09-22";
const fact = "The pilot uses the EU region and synthetic records only.";
const repeated = `${fact}\n\n${fact}`;
const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) =>
  i === 0 ? 1 : 0,
);

async function fixture(owner: string) {
  const source = await brain.write(owner, {
    title: "Pilot decision",
    type: "decision",
    markdown: `# Decision\n\n${fact}`,
    expectedVersion: 0,
  });
  const target = await brain.write(owner, {
    title: "Pilot project",
    type: "project",
    markdown: `# Pilot\n\n${repeated}\n\n[Decision](${source.slug})\n`,
    links: [{ targetRef: source.id, type: "decided_in", label: "Evidence" }],
    expectedVersion: 0,
  });
  return { source, target, pages: [source, target] };
}

function generate(pages: BrainPage[]) {
  const page = required(pages.find((item) => item.type === "project"));
  return Promise.resolve({
    model: "fixture-generator-no-provider-call",
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    rejectedProposals: [],
    proposals: [
      {
        operation: "deduplicate_passage",
        pageId: page.id,
        expectedVersion: page.version,
        before: repeated,
        after: fact,
        reason: "Remove a duplicate while retaining its decision link.",
        evidence: [{ pageId: page.id, version: page.version, quote: fact }],
      } satisfies ConsolidationProposal,
    ],
  });
}

function evaluate(
  input: Parameters<typeof evaluateCandidate>[0],
  fail = false,
) {
  return evaluateCandidate(input, {
    jev: async () => ({
      model: "typesafe-ai/jev",
      usage: { inputTokens: 0, outputTokens: 0, gateway: { cost: 0 } },
      answers: {
        supported_by_evidence: 0.01,
        preserves_distinct_information: 0.01,
        no_new_human_action: 0.01,
        meaningful_improvement: 0.2,
      },
    }),
    kimi: async (_input, selected) => {
      assert.deepEqual(selected, ["meaningful_improvement"]);
      if (fail)
        throw new GatewayRequestError("private provider body", {
          status: 503,
          retryable: true,
        });
      return {
        model: "moonshotai/kimi-k3",
        responseModel: "fixture-no-provider-call",
        responseId: null,
        latencyMs: 0,
        judgments: {
          meaningful_improvement: {
            verdict: "pass",
            rationale: "The duplicate is removed and source remains reachable.",
          },
        },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          costUsd: 0,
        },
      };
    },
  });
}

async function downstream(owner: string, runId: string, github: GitHub) {
  const embeddings = await beginWorkflowJob(
    owner,
    "embeddings",
    runDate,
    runId,
  );
  const pending = await brain.listPendingEmbeddings(owner);
  for (const page of pending)
    await indexPageFixture(
      owner,
      await brain.read(owner, { ref: page.id }),
      vector,
    );
  assert.equal((await brain.listPendingEmbeddings(owner)).length, 0);
  await finishWorkflowJob(owner, embeddings.id, runId, "succeeded", {
    indexedPages: pending.length,
    remaining: 0,
  });
  const exported = await beginWorkflowJob(owner, "export", runDate, runId);
  const snapshot = await exportBrain(owner);
  const result = await exportBrainToGitHub({
    snapshot,
    runDate,
    jobId: workflowExportAttemptKey(exported.id, exported.attempts),
    repository,
    token: "test-export-key",
    fetch: github.fetch,
  });
  assert.equal(result.commit, github.head);
  assert.deepEqual(
    JSON.parse(required(github.file("export/graph.json"))),
    snapshot.links,
  );
  for (const page of snapshot.pages)
    assert.ok(
      required(github.file(`export/pages/${page.slug}.md`)).endsWith(
        `${page.markdown}\n`,
      ),
    );
  await finishWorkflowJob(owner, exported.id, runId, "succeeded", result);
  return {
    indexedPages: pending.length,
    exportedPages: result.pages,
    exportedLinks: result.links,
  };
}

test(
  "candidate, durable receipts, pgvector indexing and Git export work together on isolated Postgres",
  { skip: process.env.RUN_DB_TESTS !== "1" },
  async (t) => {
    const owners = [
      `pipeline-${randomUUID()}`,
      `pipeline-failure-${randomUUID()}`,
    ];
    const evidence: Record<string, unknown> = {
      scope:
        "Integration of production phase functions, not execution of the durable Workflow engine",
      modelResponses:
        "Injected deterministic generator, Jev and Kimi fixtures; zero provider calls",
      database: "Real isolated PostgreSQL with native pgvector",
      github:
        "Injected in-memory immutable Git graph and remote-ref readback; no GitHub publication",
    };
    try {
      await t.test(
        "lost write acknowledgement replays once through indexing, export and restore",
        async () => {
          const owner = owners[0];
          const initial = await fixture(owner);
          const runId = "pipeline-restart";
          await queueWorkflowJobs(owner, runDate);
          const job = await beginWorkflowJob(
            owner,
            "consolidation",
            runDate,
            runId,
          );
          let loseAcknowledgement = true;
          const apply = async (page: BrainPage) => {
            const committed = await brain.applyConsolidationSnapshot(
              owner,
              page,
              {
                operationKey: `${job.id}/accepted-proposal`,
              },
            );
            if (loseAcknowledgement) {
              loseAcknowledgement = false;
              throw new Error(
                "Simulated process interruption after committed write",
              );
            }
            return committed;
          };
          const interrupted = await runConsolidationSnapshot(
            initial.pages,
            { mode: "apply" },
            { generate, evaluate: (input) => evaluate(input), apply },
          );
          assert.ok(interrupted.report.fault);
          assert.equal(interrupted.report.writes, 0);
          assert.equal(
            (await brain.read(owner, { ref: initial.target.id })).version,
            2,
          );
          assert.equal(
            (await beginWorkflowJob(owner, "consolidation", runDate, runId))
              .attempts,
            1,
          );
          const resumed = await runConsolidationSnapshot(
            initial.pages,
            { mode: "apply" },
            { generate, evaluate: (input) => evaluate(input), apply },
          );
          assert.equal(resumed.report.fault, null);
          assert.equal(resumed.report.writes, 1);
          assert.equal(resumed.report.persisted, true);
          assert.equal(
            (await brain.listRevisions(owner, { ref: initial.target.id }))
              .length,
            2,
          );
          const finished = await finishWorkflowJob(
            owner,
            job.id,
            runId,
            "succeeded",
            resumed.report,
          );
          assert.deepEqual(
            await finishWorkflowJob(owner, job.id, runId, "succeeded", {
              writes: 99,
            }),
            finished,
          );
          assert.equal(
            (
              await beginWorkflowJob(
                owner,
                "consolidation",
                runDate,
                "later-run",
              )
            ).skip,
            true,
          );
          const github = new GitHub();
          github.ambiguousOnce = true;
          const downstreamResult = await downstream(owner, runId, github);
          assert.equal(
            github.calls.filter((call) => call.method === "PATCH").length,
            1,
          );
          const stored = await getPool().query<{
            dimensions: number;
            count: number;
          }>(
            "SELECT min(vector_dims(embedding))::int AS dimensions, count(*)::int AS count FROM brain_page_chunks WHERE owner_id=$1",
            [owner],
          );
          assert.equal(stored.rows[0].dimensions, EMBEDDING_DIMENSIONS);
          assert.ok(stored.rows[0].count >= 2);
          assert.deepEqual(
            (await dailyWorkflowStatus(owner, runDate)).map(
              (phase) => phase.status,
            ),
            ["succeeded", "succeeded", "succeeded"],
          );
          const restored = await brain.restoreConsolidationRevision(
            owner,
            { ref: initial.target.id, version: 1 },
            { operationKey: `${job.id}/restore` },
          );
          assert.equal(restored.markdown, initial.target.markdown);
          assert.equal(restored.links[0].targetId, initial.source.id);
          assert.equal(restored.links[0].label, "Evidence");
          assert.equal(restored.version, 3);
          assert.equal((await brain.listPendingEmbeddings(owner)).length, 1);
          evidence.main = {
            ...downstreamResult,
            committedVersion: 2,
            revisionCountAfterReplay: 2,
            restoredVersion: restored.version,
            vectorDimensions: stored.rows[0].dimensions,
            indexedChunks: stored.rows[0].count,
            githubRefUpdates: 1,
            allJobsSucceeded: true,
          };
        },
      );
      await t.test(
        "evaluation failure writes nothing and deterministic downstream phases still complete",
        async () => {
          const owner = owners[1];
          const initial = await fixture(owner);
          const runId = "pipeline-judgment-failure";
          await queueWorkflowJobs(owner, runDate);
          const job = await beginWorkflowJob(
            owner,
            "consolidation",
            runDate,
            runId,
          );
          const result = await runConsolidationSnapshot(
            initial.pages,
            { mode: "apply" },
            {
              generate,
              evaluate: (input) => evaluate(input, true),
              apply: async () => {
                assert.fail("A failed evaluation must never reach persistence");
              },
            },
          );
          assert.equal(result.report.writes, 0);
          assert.equal(result.report.fault?.status, 503);
          assert.ok(
            !JSON.stringify(result.report).includes("private provider body"),
          );
          await finishWorkflowJob(
            owner,
            job.id,
            runId,
            "partial",
            result.report,
          );
          assert.equal(
            (await brain.read(owner, { ref: initial.target.id })).markdown,
            initial.target.markdown,
          );
          assert.equal(
            (await brain.listRevisions(owner, { ref: initial.target.id }))
              .length,
            1,
          );
          const downstreamResult = await downstream(owner, runId, new GitHub());
          assert.deepEqual(
            (await dailyWorkflowStatus(owner, runDate)).map(
              (phase) => phase.status,
            ),
            ["partial", "succeeded", "succeeded"],
          );
          evidence.failure = {
            ...downstreamResult,
            providerStatus: 503,
            writes: 0,
            newRevisions: 0,
            consolidation: "partial",
            embeddings: "succeeded",
            export: "succeeded",
          };
        },
      );
      if (process.env.BRAIN_PIPELINE_REPORT_FILE)
        await writeFile(
          process.env.BRAIN_PIPELINE_REPORT_FILE,
          `${JSON.stringify(evidence, null, 2)}\n`,
          { flag: "wx", mode: 0o600 },
        );
    } finally {
      await getPool().query(
        "DELETE FROM brain_pages WHERE owner_id=ANY($1::text[])",
        [owners],
      );
      await getPool().query(
        "DELETE FROM brain_jobs WHERE owner_id=ANY($1::text[])",
        [owners],
      );
      await getPool().end();
    }
  },
);
