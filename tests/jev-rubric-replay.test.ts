import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONSOLIDATION_QUESTIONS_V2 } from "../lib/maintenance/consolidation-rubric";
import { GatewayRequestError } from "../lib/maintenance/gateway";
import {
  JEV_BASELINE_QUESTIONS,
  JEV_CONSOLIDATION_THRESHOLDS,
  JEV_MODEL,
} from "../lib/maintenance/jev";
import {
  replayJobs,
  runRubricReplay,
} from "../scripts/evaluate-jev-rubric-replay";

const criterionKeys = Object.keys(JEV_CONSOLIDATION_THRESHOLDS);
function hash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
function evaluation(allowed = true) {
  return {
    model: JEV_MODEL,
    answers: Object.fromEntries(
      criterionKeys.map((key) => [key, allowed ? 0.95 : 0.5]),
    ),
    usage: { inputTokens: 42, outputTokens: 0, gateway: { cost: 0.001 } },
  };
}
async function fixture(count = 1) {
  const input = await mkdtemp(join(tmpdir(), "brain-rubric-replay-"));
  const cases = Array.from({ length: count }, (_, index) => {
    const item = {
      before: { caseIndex: index, markdown: "Repeated fact. Repeated fact." },
      after: { markdown: "Repeated fact." },
      evidence: [],
      operation: { operation: "deduplicate_passage" },
    };
    return {
      caseId: `case-${index}`,
      inputHash: hash(JSON.stringify(item)),
      input: item,
    };
  });
  const rubricText = `${JSON.stringify(CONSOLIDATION_QUESTIONS_V2, null, 2)}\n`;
  const review = {
    reviewer: "blind-subagent",
    rubricHash: hash(rubricText),
    candidates: cases.map((item, index) => ({
      caseId: item.caseId,
      inputHash: item.inputHash,
      criteria: Object.fromEntries(
        criterionKeys.map((key) => [
          key,
          {
            verdict: index === 1 ? "fail" : index === 2 ? "uncertain" : "pass",
            rationale: "Synthetic source supports this label.",
          },
        ]),
      ),
    })),
  };
  await Promise.all([
    writeFile(join(input, "cases.json"), JSON.stringify({ cases })),
    writeFile(join(input, "subagent-review.json"), JSON.stringify(review)),
    writeFile(join(input, "rubric.json"), rubricText),
    writeFile(
      join(input, "evaluation-spec.json"),
      JSON.stringify({ repetitions: 3 }),
    ),
  ]);
  return { input, cases, review };
}

test("complete, matching blind labels and exact shared rubric are required before any API call", async () => {
  const options = await fixture(2);
  let calls = 0;
  const dependencies = {
    evaluate: async () => {
      calls++;
      return evaluation();
    },
  };
  try {
    for (const mutate of [
      (value: typeof options.review) => value.candidates.pop(),
      (value: typeof options.review) => {
        value.candidates[1] = value.candidates[0];
      },
      (value: typeof options.review) => {
        value.candidates[0].inputHash = "0".repeat(64);
      },
      (value: typeof options.review) => {
        value.rubricHash = "0".repeat(64);
      },
      (value: typeof options.review) => {
        delete value.candidates[0].criteria.meaningful_improvement;
      },
    ]) {
      const changed = structuredClone(options.review);
      mutate(changed);
      await writeFile(
        join(options.input, "subagent-review.json"),
        JSON.stringify(changed),
      );
      await assert.rejects(runRubricReplay(options, dependencies));
      assert.equal(calls, 0);
    }
    await writeFile(
      join(options.input, "subagent-review.json"),
      JSON.stringify(options.review),
    );
    await writeFile(
      join(options.input, "rubric.json"),
      JSON.stringify(JEV_BASELINE_QUESTIONS),
    );
    await assert.rejects(
      runRubricReplay(options, dependencies),
      /review rubric differs/,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(options.input, { recursive: true, force: true });
  }
});

test("replay freezes sources and resumes saved calls without duplicate billing; receipt tampering is rejected", async () => {
  const options = await fixture(2);
  let calls = 0;
  const evaluate = async () => {
    calls++;
    return evaluation();
  };
  try {
    await assert.rejects(
      runRubricReplay(options, {
        evaluate,
        progress: ({ completed }) => {
          if (completed === 5)
            throw new Error("Synthetic process pause after durable receipt.");
        },
      }),
      /Synthetic process pause/,
    );
    assert.equal(calls, 5);
    const result = await runRubricReplay(options, { evaluate });
    assert.equal(calls, 12);
    assert.equal(result.evaluations, 12);
    assert.equal(result.uniqueCases, 2);
    assert.equal(result.cost.known, 0.012000000000000004);
    await runRubricReplay(options, { evaluate });
    assert.equal(calls, 12);
    assert.equal((await stat(options.input)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(options.input, "subagent-review.json"))).mode & 0o777,
      0o600,
    );
    assert.equal(
      (await stat(join(options.input, "receipts", "0001.json"))).mode & 0o777,
      0o600,
    );
    const reviewText = await readFile(
      join(options.input, "subagent-review.json"),
      "utf8",
    );
    await writeFile(
      join(options.input, "subagent-review.json"),
      `${reviewText}\n`,
    );
    await assert.rejects(
      runRubricReplay(options, { evaluate }),
      /Frozen experiment inputs/,
    );
    await writeFile(join(options.input, "subagent-review.json"), reviewText);
    const path = join(options.input, "receipts", "0001.json");
    const receipt = JSON.parse(await readFile(path, "utf8"));
    receipt.receipt.result.answers.supported_by_evidence = 0.91;
    await writeFile(path, JSON.stringify(receipt));
    await assert.rejects(
      runRubricReplay(options, { evaluate }),
      /Saved receipt hash differs/,
    );
    assert.equal(calls, 12);
  } finally {
    await rm(options.input, { recursive: true, force: true });
  }
});

test("balanced variant routing and three-repeat summaries retain case-level uncertainty and flips", async () => {
  const options = await fixture(3);
  const seen = new Map<string, number>();
  const order: string[] = [];
  try {
    const summary = await runRubricReplay(options, {
      evaluate: async (input, { questions }) => {
        const variant =
          questions === JEV_BASELINE_QUESTIONS ? "baseline" : "revised";
        assert.ok(
          questions === JEV_BASELINE_QUESTIONS ||
            questions === CONSOLIDATION_QUESTIONS_V2,
        );
        const index = (input.before as { caseIndex: number }).caseIndex;
        const key = `${index}-${variant}`;
        const repeat = (seen.get(key) ?? 0) + 1;
        seen.set(key, repeat);
        order.push(key);
        return evaluation(
          variant === "revised" &&
            index !== 1 &&
            !(index === 0 && repeat === 2),
        );
      },
    });
    assert.deepEqual(
      order,
      replayJobs(3).map((job) => `${job.caseIndex}-${job.variant}`),
    );
    assert.equal(summary.evaluations, 18);
    assert.equal(summary.uniqueCases, 3);
    const revised = summary.variants.revised;
    assert.equal(revised.casesWithDecisionFlips, 1);
    assert.equal(revised.byCase[0].passCount, 2);
    assert.deepEqual(
      revised.byCase[0].criteria.supported_by_evidence.scores,
      [0.95, 0.5, 0.95],
    );
    assert.equal(revised.byCase[0].criteria.supported_by_evidence.median, 0.95);
    assert.equal(revised.perRun[0].overall.pass.accepted, 1);
    assert.equal(revised.perRun[1].overall.pass.rejected, 1);
    assert.equal(revised.perRun[2].overall.fail.rejected, 1);
    assert.equal(
      revised.descriptiveStabilityPolicies.all3.overall.pass.accepted,
      0,
    );
    assert.equal(
      revised.descriptiveStabilityPolicies.majority.overall.pass.accepted,
      1,
    );
    assert.equal(
      revised.descriptiveStabilityPolicies.any.overall.uncertain.accepted,
      1,
    );
    assert.equal(summary.variants.baseline.casesWithDecisionFlips, 0);
  } finally {
    await rm(options.input, { recursive: true, force: true });
  }
});

test("only retryable Gateway failures are retried and attempts stay bounded and durable", async () => {
  const options = await fixture();
  let calls = 0;
  try {
    const result = await runRubricReplay(options, {
      evaluate: async () => {
        calls++;
        if (calls === 1)
          throw new GatewayRequestError("Do not persist this provider text.", {
            retryable: true,
            status: 429,
          });
        return evaluation();
      },
      sleep: async () => undefined,
    });
    assert.equal(calls, 7);
    assert.equal(result.evaluations, 6);
    const journalText = await readFile(
      join(options.input, "receipts", "0001.json.attempts"),
      "utf8",
    );
    assert.equal(JSON.parse(journalText).attempts.length, 2);
    assert.ok(!journalText.includes("Do not persist"));
    await runRubricReplay(options, {
      evaluate: async () => {
        throw new Error("Must not call again.");
      },
    });
  } finally {
    await rm(options.input, { recursive: true, force: true });
  }
  for (const providerError of [
    new GatewayRequestError("private provider error", { retryable: true }),
    new GatewayRequestError("private provider error", { retryable: false }),
    new Error("private unexpected error"),
  ]) {
    const failing = await fixture();
    let attempts = 0;
    try {
      await assert.rejects(
        runRubricReplay(failing, {
          evaluate: async () => {
            attempts++;
            throw providerError;
          },
          sleep: async () => undefined,
        }),
        /Evaluation failed; sanitized attempt metadata was saved/,
      );
      assert.equal(
        attempts,
        providerError instanceof GatewayRequestError && providerError.retryable
          ? 3
          : 1,
      );
      await assert.rejects(
        runRubricReplay(failing, {
          evaluate: async () => {
            attempts++;
            return evaluation();
          },
        }),
      );
      assert.equal(
        attempts,
        providerError instanceof GatewayRequestError && providerError.retryable
          ? 3
          : 1,
      );
    } finally {
      await rm(failing.input, { recursive: true, force: true });
    }
  }
});

test("declared counts, thresholds and receipt chronology cannot drift from the frozen experiment", async () => {
  const options = await fixture();
  let calls = 0;
  const dependencies = {
    evaluate: async () => {
      calls++;
      return evaluation();
    },
  };
  try {
    for (const specification of [
      { repetitions: 3, cases: 2 },
      {
        repetitions: 3,
        cases: 1,
        thresholds: {
          ...JEV_CONSOLIDATION_THRESHOLDS,
          meaningful_improvement: 0.7,
        },
      },
    ]) {
      await writeFile(
        join(options.input, "evaluation-spec.json"),
        JSON.stringify(specification),
      );
      await assert.rejects(
        runRubricReplay(options, dependencies),
        /Invalid cases, review or evaluation specification/,
      );
      assert.equal(calls, 0);
    }
    await writeFile(
      join(options.input, "evaluation-spec.json"),
      JSON.stringify({
        repetitions: 3,
        cases: 1,
        thresholds: JEV_CONSOLIDATION_THRESHOLDS,
      }),
    );
    await runRubricReplay(options, dependencies);
    assert.equal(calls, 6);
    const path = join(options.input, "receipts", "0001.json");
    const original = await readFile(path, "utf8");
    const envelope = JSON.parse(original);
    envelope.receipt.evaluatedAt = "2000-01-01T00:00:00.000Z";
    envelope.receiptHash = hash(JSON.stringify(envelope.receipt));
    await writeFile(path, JSON.stringify(envelope));
    await assert.rejects(
      runRubricReplay(options, dependencies),
      /Saved receipt refers to different frozen inputs/,
    );
    await writeFile(path, original);
    const journalPath = `${path}.attempts`;
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.attempts[0].startedAt = "2000-01-01T00:00:00.000Z";
    await writeFile(journalPath, JSON.stringify(journal));
    await assert.rejects(
      runRubricReplay(options, dependencies),
      /Saved request chronology differs/,
    );
    assert.equal(calls, 6);
  } finally {
    await rm(options.input, { recursive: true, force: true });
  }
});
