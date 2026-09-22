import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateCandidate } from "../lib/maintenance/consolidation-candidate";
import { CONSOLIDATION_CRITERIA } from "../lib/maintenance/consolidation-rubric";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import { JEV_MODEL } from "../lib/maintenance/jev";
import {
  buildReleaseCases,
  type ReceiptIdentity,
  recordedCall,
  summarizeReleaseRows,
} from "../scripts/evaluate-consolidation-release";

const identity: ReceiptIdentity = {
  protocolHash: "test-protocol",
  jobId: "G01-r1",
  kind: "jev",
  inputHash: "test-input",
  selected: [],
};

test("release inputs separate the fixed reference, use the runtime policy and replay exact receipts", async () => {
  const fixture = JSON.parse(
    await readFile("scripts/fixtures/consolidation-release-v1.json", "utf8"),
  );
  const built = buildReleaseCases(fixture);
  assert.equal(built.inputs.length, 12);
  const accepted = built.references.find(
    (r) => r.expectedDecision === "accept",
  );
  assert.ok(accepted);
  const input = built.inputs.find((r) => r.inputHash === accepted.inputHash);
  assert.ok(input);
  assert.deepEqual(Object.keys(input.input).sort(), [
    "after",
    "before",
    "evidence",
    "operation",
  ]);
  assert.ok(!JSON.stringify(input.input).includes("expectedCriteria"));
  assert.equal(
    built.references.filter((r) => r.category === "ambiguous").length,
    4,
  );
  const evaluation = await evaluateCandidate(input.input, {
    jev: async (received) => {
      assert.deepEqual(received, input.input);
      return {
        model: JEV_MODEL,
        answers: Object.fromEntries(
          CONSOLIDATION_CRITERIA.map((key) => [key, 0]),
        ),
        usage: {},
      };
    },
    kimi: async () => {
      throw new Error("All green must not call Kimi");
    },
  });
  const summary = summarizeReleaseRows([
    { ...accepted, ...evaluation, jobId: "G01-r1", repetition: 1 },
  ]);
  assert.equal(summary.correct, 1);
  assert.equal(summary.kimiCalls, 0);
  assert.equal(summary.byCriterion.supported_by_evidence.jev.correct, 1);
  const directory = await mkdtemp(join(tmpdir(), "release-receipt-"));
  try {
    let calls = 0;
    const path = join(directory, "call.json");
    const saved = await recordedCall(path, identity, "run", async () => {
      calls++;
      return { value: 42 };
    });
    const replayed = await recordedCall(path, identity, "verify", async () => {
      calls++;
      return { value: -1 };
    });
    assert.deepEqual(replayed, saved);
    assert.equal(calls, 1);
    const errorPath = join(directory, "error.json");
    const error = await recordedCall(errorPath, identity, "run", async () => {
      throw new GatewayRequestError("provider text excluded", {
        status: 429,
        retryable: true,
      });
    });
    assert.equal(error.outcome.status, "error");
    assert.ok(!JSON.stringify(error).includes("provider text excluded"));
    assert.deepEqual(
      await recordedCall(errorPath, identity, "verify", async () => 1),
      error,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown provider outcomes prevent replay or automatic retries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "release-unknown-"));
  try {
    const path = join(directory, "call.json");
    await writeFile(
      `${path}.started`,
      JSON.stringify({ identity, startedAt: "2026-09-22T00:00:00Z" }),
    );
    let calls = 0;
    await assert.rejects(
      () =>
        recordedCall(path, identity, "run", async () => {
          calls++;
          return 42;
        }),
      /Unknown provider outcome/,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
