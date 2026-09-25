import assert from "node:assert/strict";
import test from "node:test";
import type { BrainPage } from "../lib/brain/types";
import { analyzeTask } from "../lib/maintenance/consolidator/analysis";
import {
  type AnalysisTask,
  type Answer,
  type EvaluationRequest,
  type EvidenceUnit,
  POLICY,
  type Snapshot,
} from "../lib/maintenance/consolidator/types";
import { GatewayRequestError } from "../lib/maintenance/gateway";

function page(id: string, markdown: string): BrainPage {
  return {
    id,
    slug: id,
    title: id,
    type: "note",
    summary: "",
    aliases: [],
    tags: [],
    version: 1,
    createdAt: "2026-09-01",
    updatedAt: "2026-09-25",
    embeddedAt: null,
    markdown,
    links: [],
    backlinks: [],
  };
}

function fixture(texts: Record<string, string[]>): {
  snapshot: Snapshot;
  task: AnalysisTask;
} {
  const pages = Object.entries(texts).map(([id, values]) =>
    page(id, values.join("\n\n")),
  );
  const units = Object.entries(texts).flatMap(([pageId, values]) =>
    values.map((text, index) => ({
      id: `${pageId}-${index}`,
      pageId,
      start: values.slice(0, index).join("\n\n").length + (index ? 2 : 0),
      end:
        values.slice(0, index).join("\n\n").length +
        (index ? 2 : 0) +
        text.length,
      text,
      headings: [pageId],
      context: text,
    })),
  );
  return {
    snapshot: { id: "snapshot-1", createdAt: "2026-09-25", pages, units },
    task: {
      id: "task-1",
      kind: pages.length === 1 ? "document" : "pair",
      pageIds: pages.map((page) => page.id),
      unitIds: units.map((unit) => unit.id),
    },
  };
}

type Override = (
  key: string,
  request: EvaluationRequest,
) => number | string | undefined;
function evaluator(
  override: Override = () => undefined,
  requests: EvaluationRequest[] = [],
) {
  return async (request: EvaluationRequest) => {
    requests.push(request);
    const answers: Record<string, Answer> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      const key = id.split(".").at(-1) as string;
      const selected = override(id, request);
      if (question.type === "boolean") {
        answers[id] = {
          type: "boolean",
          probability:
            typeof selected === "number"
              ? selected
              : key === "sufficient" ||
                  key.startsWith("evidence_") ||
                  key.startsWith("corpus_")
                ? 1
                : 0,
        };
      } else {
        const value =
          typeof selected === "string"
            ? selected
            : key === "relationship"
              ? "compatible"
              : "none";
        answers[id] = {
          type: "choice",
          choice: value,
          probabilities: Object.fromEntries(
            Object.keys(question.criteria).map((option) => [
              option,
              option === value ? 1 : 0,
            ]),
          ),
          confidence: 1,
        };
      }
    }
    return { answers, model: "test-jev", inputTokens: 10, outputTokens: 4 };
  };
}

function duplicateAnswers(id: string): number | string | undefined {
  const key = id.split(".").at(-1);
  if (key === "entity") return "same";
  if (key === "overlap" || key === "a_in_b" || key === "b_in_a") return 1;
  if (key === "destination") return "equivalent";
  return undefined;
}

test("analysis identifies an exact duplicate keeper and keeps raw judgments", async () => {
  const { snapshot, task } = fixture({
    a: ["Marco lavora in Delta.", "Marco lavora in Delta."],
  });
  const result = await analyzeTask(snapshot, task, evaluator(duplicateAnswers));
  assert.equal(result.status, "complete");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].kind, "deduplicate");
  assert.equal(result.findings[0].status, "supported");
  assert.equal(result.findings[0].retainedUnitId, "a-0");
  assert.deepEqual(result.findings[0].unitIds, ["a-0", "a-1"]);
  assert.deepEqual(result.findings[0].evidenceUnitIds, ["a-0", "a-1"]);
  assert.equal(result.judgments[0].model, "test-jev");
  assert.equal(result.judgments[0].inputTokens, 10);
  const again = await analyzeTask(snapshot, task, evaluator(duplicateAnswers));
  assert.equal(again.findings[0].id, result.findings[0].id);
});

test("complete local text is supplied for duplicate preservation without requiring external source authentication", async () => {
  const text =
    "Aurora apre alle 09:00 dal 3 febbraio 2026. Fonte: regolamento R-7.";
  const { snapshot, task } = fixture({ a: [text, text] });
  const requests: EvaluationRequest[] = [];
  const result = await analyzeTask(
    snapshot,
    task,
    evaluator(duplicateAnswers, requests),
  );
  assert.equal(result.findings[0].status, "supported");
  const assessment = requests.find(
    (request) => "sufficient" in request.questions,
  );
  assert.ok(assessment);
  const state = assessment.state as {
    pages: { contextComplete: boolean; fullText: string }[];
  };
  assert.equal(state.pages[0].contextComplete, true);
  assert.equal(state.pages[0].fullText, snapshot.pages[0].markdown);
  assert.match(
    assessment.questions.sufficient.instructions,
    /independently authenticating named sources or retrieving their full originals is not required/,
  );
  assert.match(
    assessment.questions.sufficient.instructions,
    /correction.*DOES require/,
  );
});

test("partial windows never expose omitted page text or claim complete local context", async () => {
  const { snapshot, task } = fixture({
    a: ["Una prima informazione.", "Un'eccezione fuori dalla finestra."],
  });
  task.unitIds = [snapshot.units[0].id];
  const requests: EvaluationRequest[] = [];
  const result = await analyzeTask(
    snapshot,
    task,
    evaluator(undefined, requests),
  );
  assert.equal(result.status, "complete");
  assert.equal(requests.length, 1);
  const state = requests[0].state as {
    pages: { contextComplete: boolean; fullText: string | null }[];
  };
  assert.equal(state.pages[0].contextComplete, false);
  assert.equal(state.pages[0].fullText, null);
  assert.ok(
    !JSON.stringify(state).includes("Un'eccezione fuori dalla finestra."),
  );
});

test("distinct details and needed local context prevent supported deletion", async () => {
  for (const hazard of ["b_distinct", "b_context"]) {
    const { snapshot, task } = fixture({
      a: [
        "Marco lavora in Delta.",
        "Marco lavora in Delta dal 2025, secondo il contratto.",
      ],
    });
    const result = await analyzeTask(
      snapshot,
      task,
      evaluator((id) =>
        id.endsWith("destination")
          ? "a"
          : id.endsWith(hazard) || id.endsWith(hazard.replace("b_", "a_"))
            ? 1
            : duplicateAnswers(id),
      ),
    );
    assert.equal(result.status, "complete");
    assert.equal(result.findings[0].status, "uncertain");
  }
});

test("a split keeper preference does not veto independently proved same-page preservation", async () => {
  const { snapshot, task } = fixture({
    a: [
      "Aurora apre alle 09:00. Fonte: R-7.",
      "Aurora apre alle 09:00. Fonte: R-7.",
    ],
  });
  const base = evaluator(duplicateAnswers);
  const result = await analyzeTask(snapshot, task, async (request) => {
    const evaluation = await base(request);
    for (const [id, question] of Object.entries(request.questions)) {
      if (id.endsWith("destination") && question.type === "choice")
        evaluation.answers[id] = {
          type: "choice",
          choice: "equivalent",
          confidence: 0.75,
          probabilities: Object.fromEntries(
            Object.keys(question.criteria).map((key) => [
              key,
              key === "equivalent"
                ? 0.8
                : key === "a"
                  ? 0.16
                  : key === "insufficient"
                    ? 0.04
                    : 0,
            ]),
          ),
        };
    }
    return evaluation;
  });
  assert.equal(result.findings[0].status, "supported");
  assert.equal(result.findings[0].retainedUnitId, "a-0");
});

test("an equally suitable duplicate keeper is chosen by full information coverage before stable position", async () => {
  const { snapshot, task } = fixture({
    a: ["Marco lavora in Delta.", "Marco lavora in Delta dal 2025."],
  });
  const result = await analyzeTask(
    snapshot,
    task,
    evaluator((id) => {
      if (id.endsWith("b_in_a")) return 0;
      if (id.endsWith("b_distinct")) return 1;
      return duplicateAnswers(id);
    }),
  );
  assert.equal(result.findings[0].status, "supported");
  assert.equal(result.findings[0].retainedUnitId, "a-1");
});

test("centralization resolves a stable canonical destination but retains ambiguity", async () => {
  const { snapshot, task } = fixture({
    a: ["Il budget è 4.500 euro."],
    b: ["Il budget è 4.500 euro, IVA inclusa."],
  });
  const supported = await analyzeTask(
    snapshot,
    task,
    evaluator((id) => (id.endsWith("b_distinct") ? 1 : duplicateAnswers(id))),
  );
  assert.equal(supported.findings[0].kind, "centralize");
  assert.equal(supported.findings[0].canonicalPageId, "a");
  assert.equal(supported.findings[0].status, "supported");
  const ambiguous = await analyzeTask(
    snapshot,
    task,
    evaluator((id) =>
      id.endsWith("destination") ? "insufficient" : duplicateAnswers(id),
    ),
  );
  assert.equal(ambiguous.findings[0].status, "uncertain");
  assert.equal(ambiguous.findings[0].canonicalPageId, undefined);
});

test("all link types and directions are asked with actual state references and source identity", async () => {
  const { snapshot, task } = fixture({
    a: ["Anna lavora in Beta."],
    b: ["Beta è una società."],
  });
  const requests: EvaluationRequest[] = [];
  const result = await analyzeTask(
    snapshot,
    task,
    evaluator((id, request) => {
      const state = request.state as {
        operation?: { link?: { sourceId: string; type: string } };
      };
      if (
        id.startsWith("link_0_1_works_at") ||
        (state.operation?.link?.sourceId === "a" &&
          state.operation.link.type === "works_at" &&
          ["relation", "identity"].includes(id))
      )
        return 1;
      return undefined;
    }, requests),
  );
  const relationQuestions = requests
    .flatMap((request) => Object.entries(request.questions))
    .filter(([id]) => id.startsWith("link_") && id.endsWith("relation"));
  assert.equal(relationQuestions.length, 18);
  for (const [, question] of relationQuestions) {
    assert.match(question.instructions, /pages\[[01]\]/);
    assert.match(question.instructions, /units/);
  }
  assert.deepEqual(
    result.findings
      .filter((finding) => finding.kind === "add_link")
      .map((finding) => finding.link),
    [{ sourceId: "a", targetId: "b", type: "works_at" }],
  );
  assert.ok(
    requests.every(
      (request) =>
        Object.keys(request.questions).length <= POLICY.questionsPerRequest,
    ),
  );
});

test("a homonym never receives a supported centralization", async () => {
  const { snapshot, task } = fixture({
    a: ["Andrea Rossi vive a Roma."],
    b: ["Andrea Rossi vive a Milano."],
  });
  const result = await analyzeTask(
    snapshot,
    task,
    evaluator((id) =>
      id.endsWith("entity") ? "different" : duplicateAnswers(id),
    ),
  );
  assert.equal(result.status, "complete");
  assert.equal(result.findings.length, 0);
});

test("unresolvable conflicts remain semantic uncertainty, never incomplete coverage", async () => {
  const { snapshot, task } = fixture({
    a: ["Fonte A: il budget è 450 euro."],
    b: ["Fonte B: il budget è 4.500 euro."],
  });
  const result = await analyzeTask(
    snapshot,
    task,
    evaluator((id) => {
      const key = id.split(".").at(-1);
      return key === "relationship"
        ? "conflict"
        : key === "resolution"
          ? "a"
          : key === "entity"
            ? "same"
            : undefined;
    }),
  );
  assert.equal(result.status, "complete");
  assert.equal(result.findings[0].kind, "reconcile");
  assert.equal(result.findings[0].status, "uncertain");
});

test("a documented scope difference cannot authorize an unrelated temporal resolution", async () => {
  const { snapshot, task } = fixture({
    a: ["La tariffa domestica documentata è 20 euro."],
    b: ["La tariffa aziendale documentata è 30 euro."],
  });
  for (const [relationship, resolution, expected] of [
    ["scope", "temporal", "uncertain"],
    ["temporal", "scope", "uncertain"],
    ["scope", "scope", "supported"],
  ]) {
    const result = await analyzeTask(
      snapshot,
      task,
      evaluator((id) => {
        const key = id.split(".").at(-1);
        if (key === "relationship") return relationship;
        if (key === "resolution") return resolution;
        if (key === "entity") return "same";
        if (["scope", "transition", "sufficient"].includes(key ?? "")) return 1;
        return undefined;
      }),
    );
    assert.equal(
      result.findings.find((finding) => finding.kind === "reconcile")?.status,
      expected,
    );
  }
});

test("an uncertain compatible choice does not erase a possible contradiction", async () => {
  const { snapshot, task } = fixture({
    a: ["Il budget è 450 euro."],
    b: ["Il budget è 4.500 euro."],
  });
  const base = evaluator((id) =>
    id.endsWith("entity")
      ? "same"
      : id.endsWith("resolution")
        ? "insufficient"
        : undefined,
  );
  const result = await analyzeTask(snapshot, task, async (request) => {
    const evaluation = await base(request);
    for (const [id, question] of Object.entries(request.questions)) {
      if (id.endsWith("relationship") && question.type === "choice")
        evaluation.answers[id] = {
          type: "choice",
          choice: "compatible",
          confidence: 0.1,
          probabilities: Object.fromEntries(
            Object.keys(question.criteria).map((key) => [
              key,
              key === "compatible" ? 0.55 : key === "conflict" ? 0.45 : 0,
            ]),
          ),
        };
    }
    return evaluation;
  });
  assert.equal(result.status, "complete");
  assert.equal(result.findings[0].kind, "reconcile");
  assert.equal(result.findings[0].status, "uncertain");
});

test("source evidence outside a window can establish a correction in a changed context", async () => {
  const { snapshot, task } = fixture({
    a: [
      "Il budget è 450 euro.",
      "Fonte originale: budget approvato 4.500 euro.",
    ],
    b: ["Il budget è 4.500 euro."],
  });
  task.unitIds = ["a-0", "b-0"];
  const requests: EvaluationRequest[] = [];
  const result = await analyzeTask(
    snapshot,
    task,
    evaluator((id, request) => {
      const key = id.split(".").at(-1);
      const state = request.state as { units: EvidenceUnit[] };
      if (key === "entity") return "same";
      if (key === "relationship") return "conflict";
      if (key === "resolution") return "b";
      if (key === "correction" || key === "sufficient")
        return state.units.some((unit) => unit.id === "a-1") ? 1 : 0;
      return undefined;
    }, requests),
  );
  assert.equal(result.findings[0].status, "supported");
  assert.equal(result.findings[0].resolution, "b");
  assert.ok(result.findings[0].evidenceUnitIds.includes("a-1"));
  const assessments = requests.filter(
    (request) => "sufficient" in request.questions,
  );
  assert.equal(assessments.length, 2);
  assert.notDeepEqual(assessments[0].state, assessments[1].state);
});

test("maintenance residue must have no distinct subject knowledge", async () => {
  const { snapshot, task } = fixture({
    a: [
      "Il consolidatore ha esaminato le pagine. Il budget approvato è 450 euro.",
    ],
  });
  const result = await analyzeTask(
    snapshot,
    task,
    evaluator((id) =>
      ["residue", "distinct"].includes(id.split(".").at(-1) as string)
        ? 1
        : undefined,
    ),
  );
  assert.equal(result.findings[0].status, "uncertain");
});

test("linked source expansion is attempted even when all local text is already present", async () => {
  const { snapshot, task } = fixture({
    a: ["Il budget è 450 euro."],
    b: ["Il budget è 4.500 euro."],
  });
  const source = fixture({
    c: ["Fonte originale: il budget approvato è 4.500 euro."],
  }).snapshot;
  snapshot.pages.push(...source.pages);
  snapshot.units.push(...source.units);
  snapshot.pages[0].links.push({
    id: "source-link",
    sourceId: "a",
    targetId: "c",
    type: "references",
    label: "Fonte",
  });
  const requests: EvaluationRequest[] = [];
  const result = await analyzeTask(
    snapshot,
    task,
    evaluator((id, request) => {
      const key = id.split(".").at(-1);
      const state = request.state as { units: EvidenceUnit[] };
      if (key === "entity") return "same";
      if (key === "relationship") return "conflict";
      if (key === "resolution") return "b";
      if (key === "correction" || key === "sufficient")
        return state.units.some((unit) => unit.id === "c-0") ? 1 : 0;
      return undefined;
    }, requests),
  );
  assert.equal(result.findings[0].status, "supported");
  assert.ok(result.findings[0].evidenceUnitIds.includes("c-0"));
  assert.equal(
    requests.filter((request) => "sufficient" in request.questions).length,
    2,
  );
});

test("every unlinked third-page unit is considered in bounded windows and an original source can resolve the conflict", async () => {
  const { snapshot, task } = fixture({
    a: ["Il budget è 450 euro."],
    b: ["Il budget è 4.500 euro."],
  });
  const third = fixture({
    c: [
      ...Array.from(
        { length: 90 },
        (_, index) =>
          `Informazione distinta ${index}. ${"Contesto senza relazione. ".repeat(8)}`,
      ),
      "Fonte originale citata: il budget approvato è 4.500 euro.",
    ],
  }).snapshot;
  snapshot.pages.push(...third.pages);
  snapshot.units.push(...third.units);
  const requests: EvaluationRequest[] = [];
  const result = await analyzeTask(
    snapshot,
    task,
    evaluator((id, request) => {
      const key = id.split(".").at(-1);
      const state = request.state as { units: EvidenceUnit[] };
      if (key === "entity") return "same";
      if (key === "relationship") return "conflict";
      if (key === "resolution") return "b";
      if (key === "correction" || key === "sufficient")
        return state.units.some((unit) => unit.id === "c-90") ? 1 : 0;
      if (id.startsWith("corpus_")) {
        const question = request.questions[id];
        const index = Number(
          question.instructions.match(/units\[(\d+)\]/)?.[1],
        );
        return state.units[index].id === "c-90" ? 1 : 0;
      }
      return undefined;
    }, requests),
  );
  assert.equal(result.status, "complete");
  assert.equal(result.findings[0].status, "supported");
  assert.ok(result.findings[0].evidenceUnitIds.includes("c-90"));
  assert.ok(!result.findings[0].evidenceUnitIds.includes("c-1"));
  const corpusQuestions = requests
    .flatMap((request) => Object.keys(request.questions))
    .filter((id) => id.startsWith("corpus_"));
  assert.equal(corpusQuestions.length, third.units.length);
  assert.ok(
    requests.every(
      (request) =>
        Object.keys(request.questions).length <= POLICY.questionsPerRequest &&
        JSON.stringify(request).length <= POLICY.evaluationCharacters,
    ),
  );
});

test("relevant corpus evidence that cannot fit is incomplete, never silently truncated", async () => {
  const { snapshot, task } = fixture({
    a: ["Budget 450."],
    b: ["Budget 4.500."],
  });
  const third = fixture({
    c: Array.from(
      { length: 55 },
      (_, index) => `${index}: ${"Fonte pertinente. ".repeat(100)}`,
    ),
  }).snapshot;
  snapshot.pages.push(...third.pages);
  snapshot.units.push(...third.units);
  const requests: EvaluationRequest[] = [];
  const result = await analyzeTask(
    snapshot,
    task,
    evaluator((id) => {
      const key = id.split(".").at(-1);
      if (key === "entity") return "same";
      if (key === "relationship") return "conflict";
      if (key === "resolution") return "insufficient";
      if (key === "sufficient") return 0;
      return undefined;
    }, requests),
  );
  assert.equal(result.status, "incomplete");
  assert.ok(
    result.errors?.some(
      (error) => error.reason === "selected_corpus_evidence_exceeds_policy",
    ),
  );
  assert.equal(
    requests
      .flatMap((request) => Object.keys(request.questions))
      .filter((id) => id.startsWith("corpus_")).length,
    third.units.length,
  );
  assert.ok(result.findings.every((finding) => finding.status === "uncertain"));
});

test("retryable transport failures propagate to the durable workflow", async () => {
  const { snapshot, task } = fixture({ a: ["Budget 450."] });
  const error = new GatewayRequestError("AI Gateway returned HTTP 429.", {
    retryable: true,
    status: 429,
    retryAfterMs: 1000,
  });
  await assert.rejects(
    analyzeTask(snapshot, task, async () => {
      throw error;
    }),
    (thrown: unknown) => thrown === error,
  );
});

test("technical errors and missing answers remain incomplete rather than no-op success", async () => {
  const { snapshot, task } = fixture({ a: ["Il budget è 450 euro."] });
  for (const evaluate of [
    async () => {
      throw new Error("private provider text");
    },
    async () => ({
      model: "test",
      answers: {},
      inputTokens: 0,
      outputTokens: 0,
    }),
  ]) {
    const result = await analyzeTask(snapshot, task, evaluate);
    assert.equal(result.status, "incomplete");
    assert.equal(result.findings.length, 0);
    assert.ok(result.errors?.length);
    assert.doesNotMatch(JSON.stringify(result.errors), /private/);
  }
});

test("over-budget structural input is reported unexamined without truncation or a provider call", async () => {
  const { snapshot, task } = fixture({
    a: ["x".repeat(POLICY.evaluationCharacters)],
  });
  let called = false;
  const result = await analyzeTask(snapshot, task, async () => {
    called = true;
    throw new Error("must not call");
  });
  assert.equal(called, false);
  assert.equal(result.status, "incomplete");
  assert.equal(result.errors?.[0].reason, "evaluation_input_exceeds_policy");
});
