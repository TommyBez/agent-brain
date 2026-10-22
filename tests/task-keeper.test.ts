import assert from "node:assert/strict";
import test from "node:test";
import type { BrainPage } from "../lib/brain/types";
import { JEV_MODEL } from "../lib/maintenance/consolidator/jev";
import type {
  Answer,
  Evaluation,
  EvaluationRequest,
} from "../lib/maintenance/consolidator/types";
import { POLICY } from "../lib/maintenance/consolidator/types";
import type { GatewayCall } from "../lib/maintenance/gateway";
import {
  dueInput,
  extractedDescription,
} from "../lib/maintenance/task-keeper/apply";
import {
  type DuplicateCandidate,
  decideDuplicate,
  extractionFingerprint,
  judgeDuplicate,
  normalizeForFingerprint,
  passageIdentity,
} from "../lib/maintenance/task-keeper/dedupe";
import {
  extractCommitments,
  extractionContext,
  extractionRequestBody,
  validCalendarDate,
} from "../lib/maintenance/task-keeper/extract";
import {
  duplicateUnitId,
  type HygieneTask,
  hygieneProposals,
  hygieneRequest,
  hygieneUnitId,
} from "../lib/maintenance/task-keeper/hygiene";
import { TASK_KEEPER_LIMITS } from "../lib/maintenance/task-keeper/policy";
import {
  TASK_KEEPER_POLICY,
  TASK_KEEPER_PROMPTS,
} from "../lib/maintenance/task-keeper/prompts";
import { screenPage } from "../lib/maintenance/task-keeper/screen";
import {
  buildKeeperSnapshot,
  excerptOf,
  type KeeperLinkedPage,
} from "../lib/maintenance/task-keeper/snapshot";
import { dueKindFor, verifyItem } from "../lib/maintenance/task-keeper/verify";

const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

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

const MINUTE = `# Verbale 15/10/2026

Presenti: Mario Rossi, Giulia Bianchi.

## Azioni

- Mario Rossi preparerà il report clinico entro il 30/10/2026.
- Potremmo valutare un nuovo fornitore.
- Giulia invierà il preventivo al cliente (fatto).
`;

const project: KeeperLinkedPage = {
  id: PROJECT_ID,
  slug: "project/report-studi-clinici",
  title: "Report studi clinici",
  type: "project",
  aliases: [],
};

/** A fake Jev: answers every question from `decide`, recording requests. */
function fakeJev(decide: (id: string, request: EvaluationRequest) => number) {
  const requests: EvaluationRequest[] = [];
  const evaluate = async (request: EvaluationRequest): Promise<Evaluation> => {
    requests.push(request);
    const answers: Record<string, Answer> = {};
    for (const id of Object.keys(request.questions))
      answers[id] = { type: "boolean", probability: decide(id, request) };
    return {
      model: JEV_MODEL,
      answers,
      inputTokens: 10,
      outputTokens: 1,
    };
  };
  return { evaluate, requests };
}

function unitIndex(
  snapshot: ReturnType<typeof buildKeeperSnapshot>,
  text: string,
) {
  const index = snapshot.units.findIndex((unit) => unit.text.includes(text));
  assert.ok(index >= 0, `unit containing ${text}`);
  return index;
}

test("the keeper registry is separate: pages keep their POLICY.version", () => {
  assert.match(TASK_KEEPER_POLICY.version, /^task-keeper-v1:[a-f0-9]{16}$/);
  assert.ok(TASK_KEEPER_POLICY.version.length <= 100);
  assert.ok(POLICY.version.startsWith("page-consolidator-v5"));
  for (const prompt of Object.values(TASK_KEEPER_PROMPTS))
    assert.doesNotMatch(prompt, /ignore (all |previous )?instructions/i);
});

test("screening gates localization at 0.80 and selects passages at 0.70", async () => {
  const snapshot = buildKeeperSnapshot(page(MINUTE), []);
  const negative = fakeJev(() => 0.79);
  assert.deepEqual(await screenPage(snapshot, negative.evaluate), {
    status: "negative",
    probability: 0.79,
  });
  assert.equal(negative.requests.length, 1, "no localization after a no");
  assert.deepEqual(Object.keys(negative.requests[0].questions), ["screening"]);

  const commitment = unitIndex(snapshot, "Mario Rossi preparerà");
  const done = unitIndex(snapshot, "Giulia invierà");
  const positive = fakeJev((id, request) => {
    if (id === "screening") return 0.9;
    const units = (request.state as { units: { text: string }[] }).units;
    const text = units[Number(id.slice("passage_".length))].text;
    if (text.includes("Mario Rossi preparerà")) return 0.7;
    if (text.includes("Giulia invierà")) return 0.75;
    return 0.69;
  });
  const result = await screenPage(snapshot, positive.evaluate);
  assert.equal(result.status, "candidates");
  assert.deepEqual(
    result.status === "candidates" ? result.candidates : [],
    [commitment, done].sort((a, b) => a - b),
  );
  assert.equal(positive.requests.length, 2);

  const empty = fakeJev((id) => (id === "screening" ? 1 : 0));
  assert.equal(
    (await screenPage(snapshot, empty.evaluate)).status,
    "no_passages",
  );
});

test("extraction cuts the excerpt from the snapshot and drops unknown ids", async () => {
  const snapshot = buildKeeperSnapshot(page(MINUTE), [project]);
  const commitment = unitIndex(snapshot, "Mario Rossi preparerà");
  const proposal = unitIndex(snapshot, "Potremmo valutare");
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const send = (async (path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    return {
      id: "gen-1",
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              items: [
                {
                  passageIds: [`u${commitment}`, "u999"],
                  title: "  Preparare il report clinico​ ",
                  actorNames: ["Mario Rossi", "mario rossi"],
                  dueText: "entro il 30/10/2026",
                  dueDate: "2026-10-30",
                  projectRef: "j0",
                },
                {
                  // Not a localized candidate: never a task.
                  passageIds: [`u${proposal}`],
                  title: "Valutare un nuovo fornitore",
                  actorNames: [],
                  dueText: null,
                  dueDate: null,
                  projectRef: null,
                },
                {
                  passageIds: [`u${commitment}`],
                  title: "Con data impossibile",
                  actorNames: [],
                  dueText: null,
                  dueDate: "2026-02-30",
                  projectRef: "j7",
                },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    };
  }) as unknown as GatewayCall;
  const items = await extractCommitments(snapshot, [commitment], send);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "chat/completions");
  assert.equal(calls[0].body.temperature, 0);
  const format = calls[0].body.response_format as {
    json_schema: { strict: boolean };
  };
  assert.equal(format.json_schema.strict, true);
  assert.deepEqual(items, [
    {
      passages: [commitment],
      title: "Preparare il report clinico",
      actorNames: ["Mario Rossi"],
      dueText: "entro il 30/10/2026",
      dueDate: "2026-10-30",
      projectId: PROJECT_ID,
    },
    {
      passages: [commitment],
      title: "Con data impossibile",
      actorNames: [],
      dueText: null,
      dueDate: null,
      projectId: null,
    },
  ]);
  const excerpt = excerptOf(snapshot, items[0].passages);
  const unit = snapshot.units[commitment];
  assert.equal(
    MINUTE.slice(excerpt.startOffset, excerpt.endOffset),
    unit.text,
    "offsets address the snapshot's Markdown",
  );
  assert.equal(excerpt.text, unit.text.trim());
  assert.match(
    extractedDescription(snapshot, excerpt),
    new RegExp(`^> - Mario Rossi[\\s\\S]*/pages/${PAGE_ID}\\) · version 3$`),
  );
});

test("the extraction request uses short aliases and only the page's projects", () => {
  const snapshot = buildKeeperSnapshot(page(MINUTE), [project]);
  const context = extractionContext(snapshot, [1]);
  assert.deepEqual(context.content.candidatePassageIds, ["u1"]);
  assert.deepEqual(context.content.projects, [
    { id: "j0", title: "Report studi clinici" },
  ]);
  assert.ok(context.content.units.every((unit) => /^u\d+$/.test(unit.id)));
  const body = extractionRequestBody(context.content);
  assert.equal(body.model, "deepseek/deepseek-v4.1-flash-1017");
  assert.equal(validCalendarDate("2026-10-30"), "2026-10-30");
  assert.equal(validCalendarDate("30/10/2026"), null);
  assert.equal(validCalendarDate("2026-13-01"), null);
});

test("verification keeps only explicit, open commitments and drops unsupported fields", async () => {
  const snapshot = buildKeeperSnapshot(page(MINUTE), []);
  const commitment = unitIndex(snapshot, "Mario Rossi preparerà");
  const item = {
    passages: [commitment],
    title: "Preparare il report clinico",
    actorNames: ["Mario Rossi"],
    dueText: "entro il 30/10/2026",
    dueDate: "2026-10-30",
    projectId: null,
  };
  const answers = (values: Record<string, number>) =>
    fakeJev((id) => values[id] ?? 0).evaluate;

  const hypothesis = await verifyItem(
    snapshot,
    item,
    answers({ explicit_commitment: 0.79, already_done: 0 }),
  );
  assert.equal(hypothesis.status, "not_commitment");

  const done = await verifyItem(
    snapshot,
    item,
    answers({ explicit_commitment: 0.95, already_done: 0.8 }),
  );
  assert.equal(done.status, "already_done");

  const partial = await verifyItem(
    snapshot,
    item,
    answers({
      explicit_commitment: 0.9,
      already_done: 0.1,
      actor_supported: 0.5,
      due_text_supported: 0.9,
      due_date_supported: 0.4,
    }),
  );
  assert.equal(partial.status, "accepted");
  if (partial.status !== "accepted") return;
  assert.deepEqual(partial.dropped, ["actors", "dueDate"]);
  assert.deepEqual(partial.item.actorNames, []);
  assert.equal(partial.item.dueDate, null);
  assert.equal(partial.item.dueKind, "approximate");

  const noDue = await verifyItem(
    snapshot,
    item,
    answers({
      explicit_commitment: 0.9,
      actor_supported: 0.9,
      due_text_supported: 0.2,
      due_date_supported: 0.2,
    }),
  );
  assert.equal(noDue.status === "accepted" && noDue.item.dueKind, "unset");

  const verified = fakeJev(() => 0.9);
  verified.requests.length = 0;
  const plain = { ...item, actorNames: [], dueText: null, dueDate: null };
  await verifyItem(snapshot, plain, verified.evaluate);
  assert.deepEqual(Object.keys(verified.requests[0].questions).sort(), [
    "already_done",
    "explicit_commitment",
  ]);
  assert.deepEqual(
    (verified.requests[0].state as { source: { passages: string[] } }).source
      .passages,
    [snapshot.units[commitment].text],
  );
});

test("due kinds: a date, a meeting wording or an approximate wording", () => {
  assert.equal(dueKindFor({ dueText: null, dueDate: null }), "unset");
  assert.equal(
    dueKindFor({ dueText: "entro il 30/10", dueDate: "2026-10-30" }),
    "date",
  );
  assert.equal(
    dueKindFor({ dueText: "alla prossima riunione", dueDate: null }),
    "event",
  );
  assert.equal(
    dueKindFor({ dueText: "entro fine mese", dueDate: null }),
    "approximate",
  );
  const excerpt = { startOffset: 0, endOffset: 10, text: "Mario\npreparerà" };
  assert.deepEqual(
    dueInput(
      {
        passages: [0],
        title: "x",
        actorNames: [],
        dueText: "alla prossima riunione",
        dueDate: null,
        projectId: null,
        dueKind: "event",
      },
      excerpt,
    ),
    {
      kind: "event",
      text: "alla prossima riunione",
      sourceExcerpt: "Mario preparerà",
    },
  );
});

test("extraction fingerprints ignore spacing and case but not the source page", () => {
  const a = extractionFingerprint(
    PAGE_ID,
    ["- Mario  preparerà il report.\n"],
    "Preparare il Report",
  );
  const b = extractionFingerprint(
    PAGE_ID,
    ["- mario preparerà il report"],
    "preparare il report!",
  );
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.notEqual(
    a,
    extractionFingerprint(
      PROJECT_ID,
      ["- mario preparerà il report"],
      "preparare il report",
    ),
  );
  assert.equal(normalizeForFingerprint("  È  Già—fatto! "), "è già fatto");
});

test("a passage identity ignores the model's title and formatting, not the page or the text", () => {
  const passage = passageIdentity(
    PAGE_ID,
    "- Giulia → Inviare il preventivo\n",
  );
  assert.match(passage, /^[a-f0-9]{64}$/);
  assert.equal(
    passageIdentity(PAGE_ID, "- giulia → inviare il preventivo"),
    passage,
  );
  assert.notEqual(
    passageIdentity(PROJECT_ID, "- Giulia → Inviare il preventivo"),
    passage,
  );
  assert.notEqual(
    passageIdentity(PAGE_ID, "- Giulia → Inviare il contratto"),
    passage,
  );
  // The extraction fingerprint moves with a reworded title; the passage does not.
  assert.notEqual(
    extractionFingerprint(
      PAGE_ID,
      ["- Giulia → Inviare il preventivo"],
      "Inviare il preventivo",
    ),
    extractionFingerprint(
      PAGE_ID,
      ["- Giulia → Inviare il preventivo"],
      "Mandare il preventivo",
    ),
  );
});

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

test("dedupe: a match becomes new_source, a rejected match stays rejected", async () => {
  const candidate = (
    overrides: Partial<DuplicateCandidate>,
  ): DuplicateCandidate => ({
    id: "33333333-3333-4333-8333-333333333333",
    number: 7,
    title: "Preparare il report clinico",
    description: "",
    acceptanceCriteria: [],
    status: "ready",
    rejected: false,
    sameSource: false,
    ...overrides,
  });
  const item = {
    passages: [0],
    title: "Preparare il report",
    actorNames: [],
    dueText: null,
    dueDate: null,
    projectId: null,
    dueKind: "unset" as const,
  };
  const excerpt = { startOffset: 0, endOffset: 5, text: "report" };
  const none = fakeJev(() => 0.5);
  assert.deepEqual(await judgeDuplicate(item, excerpt, [], none.evaluate), {
    outcome: "none",
  });
  assert.equal(none.requests.length, 0, "no candidates, no request");
  assert.deepEqual(
    await judgeDuplicate(item, excerpt, [candidate({})], none.evaluate),
    { outcome: "none" },
  );
  const yes = fakeJev((id) => (id === "duplicate_c1" ? 0.92 : 0.81));
  const decision = await judgeDuplicate(
    item,
    excerpt,
    [candidate({ number: 3 }), candidate({ number: 9 })],
    yes.evaluate,
  );
  assert.ok(decision.outcome === "new_source");
  assert.equal(decision.candidate.number, 9);
  assert.equal(
    decideDuplicate(
      { candidate: candidate({ rejected: true }), probability: 0.9 },
      "report",
    ).outcome,
    "rejected",
  );
  const quoted = candidate({
    sameSource: true,
    description: "> - Mario preparerà il report entro il 30/10.\n\nSource: …",
  });
  assert.equal(
    decideDuplicate(
      { candidate: quoted, probability: 0.9 },
      "- Mario  preparerà il report entro il 30/10",
    ).outcome,
    "existing",
    "the same passage of the same page is not a new source",
  );
  assert.equal(
    decideDuplicate(
      { candidate: quoted, probability: 0.9 },
      "- Mario preparerà il report entro il 06/11",
    ).outcome,
    "new_source",
    "a moved deadline in the same page is",
  );
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
