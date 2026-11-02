import assert from "node:assert/strict";
import test from "node:test";
import type { BrainPage } from "../lib/brain/types";
import {
  duplicateUnitId,
  type HygieneTask,
  hygieneProposals,
  hygieneRequest,
  hygieneUnitId,
} from "../lib/maintenance/task-keeper/hygiene";
import { TASK_KEEPER_LIMITS } from "../lib/maintenance/task-keeper/policy";

function page(markdown: string, overrides: Partial<BrainPage> = {}): BrainPage {
  return {
    id: PAGE_ID,
    slug: "note/verbale-15-10",
    title: "Verbale 15/10/2026",
    type: "note",
    summary: "Riunione di progetto",
    relationships: [],
    aliases: [],
    tags: [],
    version: 3,
    createdAt: "2026-10-15T10:00:00.000Z",
    updatedAt: "2026-10-15T10:00:00.000Z",
    embeddedAt: null,
    markdown,
    links: [],
    backlinks: [],
    ...overrides,
  };
}

const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
test("hygiene and duplicate units are per task: identical instances are judged separately", () => {
  const task = (id: string): HygieneTask => ({
    id,
    number: 1,
    title: "Inviare il report settimanale",
    description: "Vedi /pages/x",
    acceptanceCriteria: [],
    projectPageId: PROJECT_ID,
    pageIds: [PAGE_ID],
  });
  const fingerprints = new Map([[PAGE_ID, "f".repeat(64)]]);
  const a = task("44444444-4444-4444-8444-444444444441");
  const b = task("44444444-4444-4444-8444-444444444442");
  const c = task("44444444-4444-4444-8444-444444444443");
  assert.match(hygieneUnitId(a, fingerprints), /^[a-f0-9]{64}$/);
  assert.equal(
    hygieneUnitId(a, fingerprints),
    hygieneUnitId({ ...a }, fingerprints),
  );
  assert.notEqual(
    hygieneUnitId(a, fingerprints),
    hygieneUnitId(b, fingerprints),
  );
  assert.notEqual(
    hygieneUnitId(a, fingerprints),
    hygieneUnitId(a, new Map([[PAGE_ID, "e".repeat(64)]])),
  );
  assert.notEqual(duplicateUnitId({ a, b }), duplicateUnitId({ a, b: c }));
  assert.notEqual(duplicateUnitId({ a, b }), duplicateUnitId({ a: b, b: a }));
  assert.notEqual(
    duplicateUnitId({ a, b }),
    duplicateUnitId({ a, b: { ...b, title: "Inviare il report mensile" } }),
  );
  // The hygiene request carries no ids, so the evaluation cache serves both.
  assert.deepEqual(hygieneRequest(a, []).state, hygieneRequest(b, []).state);
});

test("hygiene: one boolean per state and criterion, thresholds 0.85 and 0.80", () => {
  const task: HygieneTask = {
    id: "44444444-4444-4444-8444-444444444444",
    number: 12,
    title: "Migrare il database",
    description: "",
    acceptanceCriteria: ["Backup verificato", "Cutover eseguito"],
    projectPageId: null,
    pageIds: [PAGE_ID, PROJECT_ID],
  };
  const pages = [
    page("La migrazione è completata."),
    page("La migrazione è ancora in corso.", {
      id: PROJECT_ID,
      slug: "project/x",
      title: "X",
    }),
  ];
  const request = hygieneRequest(task, pages);
  assert.deepEqual(Object.keys(request.questions).sort(), [
    "canceled_p0",
    "canceled_p1",
    "criterion_0",
    "criterion_1",
    "divergent",
    "done_p0",
    "done_p1",
    "moved_p0",
    "moved_p1",
  ]);
  for (const question of Object.values(request.questions))
    assert.doesNotMatch(question.instructions, /Backup verificato/);
  const proposals = hygieneProposals(
    task,
    pages,
    {
      done_p0: 0.9,
      canceled_p0: 0.2,
      done_p1: 0.84,
      criterion_0: 0.86,
      criterion_1: 0.5,
      divergent: 0.8,
    },
    request.criteria,
  );
  assert.deepEqual(
    proposals.map((proposal) => [
      proposal.kind,
      proposal.dedupeKey.split(":")[0],
    ]),
    [
      ["may_be_done", "may_be_done"],
      ["criterion_evidence", "criterion_evidence"],
      ["divergent_state", "divergent_state"],
    ],
  );
  assert.equal(proposals[0].payload.action, "close");
  assert.equal(proposals[0].citations[0].pageId, PAGE_ID);
  assert.equal(proposals[2].citations.length, 2, "lists every source");
  assert.equal(TASK_KEEPER_LIMITS.openSuggestionsPerTask, 3);
});

test("a budget or a 402 halts the pass; other provider errors fail one page", async () => {
  const { stepFailure } = await import(
    "../lib/maintenance/task-keeper/step-failure"
  );
  const { BudgetExhaustedError } = await import(
    "../lib/maintenance/consolidator/budget"
  );
  const { GatewayRequestError } = await import("../lib/maintenance/gateway");
  const { EditorResponseError } = await import(
    "../lib/maintenance/consolidator/diagnostics"
  );
  const { JevResponseError } = await import(
    "../lib/maintenance/consolidator/jev"
  );
  assert.deepEqual(stepFailure(new BudgetExhaustedError("task_keeper"), 2), {
    requests: 2,
    halt: "budget",
    failed: false,
  });
  assert.deepEqual(
    stepFailure(
      new GatewayRequestError("HTTP 402", { retryable: false, status: 402 }),
      1,
    ),
    { requests: 1, halt: "provider", failed: false },
  );
  const quiet = console.error;
  console.error = () => undefined;
  try {
    for (const error of [
      new GatewayRequestError("HTTP 503", { retryable: true, status: 503 }),
      new EditorResponseError("invalid_schema", {}),
      new JevResponseError("answer_keys"),
    ])
      assert.deepEqual(stepFailure(error, 1), {
        requests: 1,
        halt: null,
        failed: true,
      });
  } finally {
    console.error = quiet;
  }
  assert.throws(
    () => stepFailure(new Error("database down"), 0),
    /database down/,
  );
});
