import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { evaluateJev, JEV_MODEL } from "../lib/maintenance/consolidator/jev";
import { EVIDENCE_RULES } from "../lib/maintenance/consolidator/prompts";
import type { EvaluationRequest } from "../lib/maintenance/consolidator/types";
import { POLICY } from "../lib/maintenance/consolidator/types";
import type { GatewayCall } from "../lib/maintenance/gateway";
import {
  type AnalyzedCandidate,
  type LinkAnalysis,
  planJevLinks,
} from "../lib/maintenance/task-links/apply";
import {
  benchmarkMetrics,
  benchmarkRequest,
  benchmarkSchema,
  type CasePrediction,
} from "../lib/maintenance/task-links/benchmark";
import {
  type CandidateRef,
  type CompletedPass,
  excerptFor,
  jevQueue,
  linkInputsFingerprint,
  linkUnitId,
  pageEvidenceFingerprint,
  selectCandidates,
  taskLinkKeys,
  titleNames,
} from "../lib/maintenance/task-links/candidates";
import {
  AUTO_APPLY_OFF,
  AUTO_APPLY_THRESHOLDS,
  autoApplyState,
  type RoleReviewMetrics,
  roleGate,
  TASK_LINK_AUTO_APPLY,
} from "../lib/maintenance/task-links/gate";
import {
  resolveTaskPromptProfile,
  TASK_LINK_POLICY,
} from "../lib/maintenance/task-links/policy";
import {
  buildLinkRequest,
  type JevPage,
  linkRole,
  readJudgments,
} from "../lib/maintenance/task-links/questions";
import { briefRefs, orderBriefLinks } from "../lib/tasks/brief";
import {
  type ExistingTaskLink,
  type MachineLinkWrite,
  planRuleLinks,
} from "../lib/tasks/links";
import {
  lexicalQuery,
  planRetrieval,
  RETRIEVAL_POLICY,
  retrievalWrites,
  taskDigest,
  taskSemanticFingerprint,
} from "../lib/tasks/retrieval";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ref = (n: number, source: CandidateRef["source"]): CandidateRef => ({
  pageId: uuid(n),
  source,
});
const page = (type: string, n = 1): JevPage => ({
  title: `Page ${n}`,
  type,
  summary: "s".repeat(800),
  excerpt: "e".repeat(2000),
});
const link = (overrides: Partial<ExistingTaskLink>): ExistingTaskLink => ({
  pageId: uuid(1),
  role: "context",
  origin: "consolidator",
  status: "suggested",
  confidence: 0.9,
  evidence: {},
  decidedAt: null,
  ...overrides,
});

test("candidates keep the (a) → (b) → (c) order, limits, exclusions and uniqueness", () => {
  const neighborhood = [1, 2, 3, 4, 5, 6].map((n) =>
    ref(n, n < 4 ? "decided_in" : "neighbor"),
  );
  const retrieval = [2, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((n) =>
    ref(n, "retrieval"),
  );
  const resolved = [18, 7, 19, 20].map((n) => ref(n, "resolve"));
  const chosen = selectCandidates({
    neighborhood,
    retrieval,
    resolved,
    excluded: [uuid(3)],
  });
  assert.equal(chosen.length, TASK_LINK_POLICY.maxCandidates);
  assert.deepEqual(
    chosen.map((candidate) => candidate.pageId),
    [1, 2, 4, 5, 8, 9, 10, 11, 12, 13, 18, 7].map(uuid),
  );
  assert.equal(new Set(chosen.map((item) => item.pageId)).size, 12);
  assert.equal(
    chosen.filter((item) => item.source !== "retrieval").length,
    TASK_LINK_POLICY.neighborhood + TASK_LINK_POLICY.resolved,
  );
  assert.deepEqual(
    selectCandidates({
      neighborhood: [],
      retrieval: [ref(1, "retrieval")],
      resolved: [],
      excluded: [uuid(1)],
    }),
    [],
  );
});

test("LinkUnit ids bind the policy, the task, its fingerprint and each candidate's evidence", () => {
  const base = {
    policyVersion: "task-linker-v1:p:1",
    taskId: uuid(1),
    taskFingerprint: "a".repeat(64),
    candidateFingerprints: ["b".repeat(64), "c".repeat(64)],
  };
  const id = linkUnitId(base);
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(linkUnitId({ ...base }), id);
  for (const changed of [
    { ...base, policyVersion: "task-linker-v1:p:2" },
    // Same text, another task (recurrence instances): its own analysis.
    { ...base, taskId: uuid(2) },
    { ...base, taskFingerprint: "d".repeat(64) },
    { ...base, candidateFingerprints: ["b".repeat(64), "e".repeat(64)] },
    { ...base, candidateFingerprints: ["c".repeat(64), "b".repeat(64)] },
    { ...base, candidateFingerprints: ["b".repeat(64)] },
  ])
    assert.notEqual(linkUnitId(changed), id);
  assert.equal(taskLinkKeys.analysis(id), `task-link:analysis:${id}`);
  assert.equal(taskLinkKeys.apply(id, "run-1"), `task-link:apply:${id}:run-1`);
  assert.notEqual(
    taskLinkKeys.apply(id, "run-2"),
    taskLinkKeys.apply(id, "run-1"),
  );
  assert.ok(TASK_LINK_POLICY.version.startsWith("task-linker-v1:"));
  assert.equal(
    linkUnitId({
      taskId: base.taskId,
      taskFingerprint: base.taskFingerprint,
      candidateFingerprints: [],
    }),
    linkUnitId({
      policyVersion: TASK_LINK_POLICY.version,
      taskId: base.taskId,
      taskFingerprint: base.taskFingerprint,
      candidateFingerprints: [],
    }),
  );

  const evidence = {
    id: uuid(1),
    slug: "decision/a",
    type: "decision",
    title: "A",
    summary: "",
    markdown: "Text",
    relationships: [],
    aliases: [],
    tags: [],
    links: [
      { targetId: uuid(3), type: "decided_in", label: "" },
      { targetId: uuid(2), type: "relates_to", label: "" },
    ],
  };
  const fp = pageEvidenceFingerprint(evidence);
  assert.equal(
    pageEvidenceFingerprint({
      ...evidence,
      links: [...evidence.links].reverse(),
    }),
    fp,
  );
  assert.notEqual(
    pageEvidenceFingerprint({ ...evidence, markdown: "Other" }),
    fp,
  );
  assert.notEqual(pageEvidenceFingerprint({ ...evidence, links: [] }), fp);
});

test("the task semantic fingerprint and digest ignore everything but content and project", () => {
  const task = {
    title: "Preparare il report",
    description: "Dettagli ".repeat(200),
    acceptanceCriteria: ["Formato concordato"],
    projectPageId: uuid(9),
  };
  const fp = taskSemanticFingerprint(task);
  assert.equal(
    taskSemanticFingerprint({
      ...task,
      status: "in_progress",
      version: 9,
    } as never),
    fp,
  );
  assert.notEqual(
    taskSemanticFingerprint({ ...task, projectPageId: null }),
    fp,
  );
  assert.notEqual(
    taskSemanticFingerprint({ ...task, acceptanceCriteria: [] }),
    fp,
  );
  const digest = taskDigest(task);
  assert.ok(digest.length <= RETRIEVAL_POLICY.digestCharacters);
  assert.ok(digest.startsWith("Preparare il report Formato concordato"));
  assert.equal(
    lexicalQuery(
      "Inviare il report sugli studi clinici a Farmalab, per il 16/10",
    ),
    "inviare or report or studi or clinici or farmalab",
  );
  assert.equal(lexicalQuery("a b"), "a b");
  assert.deepEqual(
    titleNames("Inviare l'offerta a Officine Rinaldi entro venerdì"),
    ["Officine Rinaldi"],
  );
  assert.deepEqual(titleNames("JSB: decidere il monitoraggio con Damato"), [
    "JSB",
    "Damato",
  ]);
});

test("one Jev request per task asks booleans only, by page type, within the limits", () => {
  const types = [
    "decision",
    "person",
    "company",
    "note",
    "decision",
    "project",
    "article",
    "person",
    "decision",
    "company",
    "note",
    "decision",
  ];
  const request = buildLinkRequest(
    {
      title: "Task",
      description: "d".repeat(5000),
      acceptanceCriteria: Array.from({ length: 20 }, () => "c".repeat(500)),
    },
    types.map((type, index) => page(type, index)),
  );
  const keys = Object.keys(request.questions);
  // 12 relevance questions plus one governs or stakeholder per eligible page.
  assert.equal(keys.length, 20);
  assert.ok(
    Object.values(request.questions).every(
      (question) => question.type === "boolean",
    ),
  );
  assert.deepEqual(
    keys.filter((key) => key.startsWith("governs_")),
    ["governs_p1", "governs_p5", "governs_p9", "governs_p12"],
  );
  assert.deepEqual(
    keys.filter((key) => key.startsWith("stakeholder_")),
    ["stakeholder_p2", "stakeholder_p3", "stakeholder_p8", "stakeholder_p10"],
  );
  assert.ok(keys.length <= POLICY.questionsPerRequest);
  assert.ok(JSON.stringify(request).length < POLICY.evaluationCharacters);
  const state = request.state as {
    task: { description: string };
    pages: Record<string, { summary: string; excerpt: string }>;
  };
  assert.equal(state.task.description.length, 3000);
  assert.equal(state.pages.p1.summary.length, 500);
  assert.equal(state.pages.p1.excerpt.length, 1200);
  const instructions = request.questions.relevant_p3.instructions;
  assert.match(instructions, /pages\.p3/);
  assert.ok(instructions.endsWith(EVIDENCE_RULES));
  assert.match(instructions, /untrusted data written by the owner or agents/);
  assert.throws(() =>
    buildLinkRequest(
      { title: "T", description: "", acceptanceCriteria: [] },
      [],
    ),
  );
});

test("prompts come from the task registry and leave the page policy untouched", () => {
  const profile = resolveTaskPromptProfile();
  assert.equal(profile.id, "task-linker-baseline-2026-10-21");
  assert.throws(
    () => resolveTaskPromptProfile("missing"),
    /JEV_TASK_PROMPT_PROFILE/,
  );
  const previous = process.env.JEV_PROMPT_PROFILE;
  try {
    delete process.env.JEV_PROMPT_PROFILE;
    assert.equal(
      POLICY.version,
      "page-consolidator-v5:apo-2026-10-16-completo-italiano-v1:12ac28df5ec147d03c7e09d8414a292574a98e2d67089a70075c4211c664a1d6",
    );
  } finally {
    if (previous === undefined) delete process.env.JEV_PROMPT_PROFILE;
    else process.env.JEV_PROMPT_PROFILE = previous;
  }
});

test("roles map from booleans at 0.80: decision, stakeholder, else context", () => {
  assert.equal(linkRole({ relevant: 0.79, governs: 1 }), null);
  assert.deepEqual(linkRole({ relevant: 0.9, governs: 0.85 }), {
    role: "decision",
    score: 0.85,
  });
  assert.deepEqual(linkRole({ relevant: 0.9, governs: 0.79 }), {
    role: "context",
    score: 0.9,
  });
  assert.deepEqual(linkRole({ relevant: 0.8, stakeholder: 0.95 }), {
    role: "stakeholder",
    score: 0.8,
  });
  assert.deepEqual(linkRole({ relevant: 0.85 }), {
    role: "context",
    score: 0.85,
  });
});

test("a mocked Jev answer travels through the evaluator into judgments and roles", async () => {
  const pages = [page("decision", 1), page("person", 2), page("note", 3)];
  const request = buildLinkRequest(
    { title: "T", description: "D", acceptanceCriteria: [] },
    pages,
  );
  const probabilities: Record<string, number> = {
    relevant_p1: 0.92,
    governs_p1: 0.88,
    relevant_p2: 0.81,
    stakeholder_p2: 0.4,
    relevant_p3: 0.3,
  };
  const calls: unknown[] = [];
  const send = (async (path: string, body: unknown) => {
    calls.push({ path, body });
    const asked = (body as EvaluationRequest).questions;
    return {
      model: JEV_MODEL,
      answers: Object.fromEntries(
        Object.keys(asked).map((key) => [
          key,
          { type: "boolean", probability: probabilities[key] },
        ]),
      ),
      usage: { inputTokens: 1000, outputTokens: 5 },
    };
  }) as GatewayCall;
  const evaluation = await evaluateJev(request, send);
  assert.equal(calls.length, 1);
  const judgments = readJudgments(pages, evaluation.answers);
  assert.deepEqual(
    judgments.map((judgment) => linkRole(judgment)?.role ?? null),
    ["decision", "context", null],
  );
  assert.deepEqual(judgments[1], { relevant: 0.81, stakeholder: 0.4 });
});

const TASK_FP = "a".repeat(64);
const candidate = (
  overrides: Partial<AnalyzedCandidate> = {},
): AnalyzedCandidate => ({
  pageId: uuid(1),
  type: "note",
  version: 2,
  fingerprint: "p".repeat(64),
  source: "retrieval",
  startOffset: 0,
  endOffset: 10,
  judgment: { relevant: 0.9 },
  ...overrides,
});
const analysis = (candidates: AnalyzedCandidate[]): LinkAnalysis => ({
  unitId: "u".repeat(64),
  policyVersion: "task-linker-v1:test",
  taskId: uuid(100),
  taskFingerprint: TASK_FP,
  evaluationKey: "evaluation:x",
  candidates,
});
const evaluated = (fps: { task?: string; page?: string } = {}) => ({
  basis: "jev",
  taskFingerprint: fps.task ?? TASK_FP,
  pageFingerprint: fps.page ?? "p".repeat(64),
});
const only = (writes: MachineLinkWrite[]) =>
  writes.map(({ pageId, role, origin, status, confidence }) => ({
    pageId,
    role,
    origin,
    status,
    confidence,
  }));

test("Jev links start suggested and never touch owner, agent, provenance, task keeper or rejected rows", () => {
  assert.deepEqual(
    only(planJevLinks(analysis([candidate()]), [], AUTO_APPLY_OFF)),
    [
      {
        pageId: uuid(1),
        role: "context",
        origin: "consolidator",
        status: "suggested",
        confidence: 0.9,
      },
    ],
  );
  const [write] = planJevLinks(analysis([candidate()]), [], AUTO_APPLY_OFF);
  assert.equal(write.evidence.basis, "jev");
  assert.equal(
    write.evidence.recordKey,
    `task-link:analysis:${"u".repeat(64)}`,
  );
  assert.equal(write.evidence.taskFingerprint, TASK_FP);
  for (const origin of ["owner", "agent", "provenance", "task_keeper"])
    assert.deepEqual(
      planJevLinks(
        analysis([candidate({ judgment: { relevant: 0.1 } })]),
        [
          link({
            origin,
            status: "suggested",
            evidence: evaluated({ task: "old" }),
          }),
        ],
        AUTO_APPLY_OFF,
      ),
      [],
    );
  for (const origin of ["consolidator", "rule", "owner"])
    assert.deepEqual(
      planJevLinks(
        analysis([candidate()]),
        [
          link({
            origin,
            status: "rejected",
            decidedAt: "2026-10-20T00:00:00.000Z",
          }),
        ],
        AUTO_APPLY_OFF,
      ),
      [],
    );
  // Jev confirms an undecided retrieval suggestion by taking it over…
  assert.deepEqual(
    only(
      planJevLinks(
        analysis([candidate()]),
        [
          link({
            origin: "rule",
            confidence: null,
            evidence: { basis: "retrieval" },
          }),
        ],
        AUTO_APPLY_OFF,
      ),
    ),
    [
      {
        pageId: uuid(1),
        role: "context",
        origin: "consolidator",
        status: "suggested",
        confidence: 0.9,
      },
    ],
  );
  // …supersedes it with another role, and only annotates what it does not confirm.
  assert.deepEqual(
    only(
      planJevLinks(
        analysis([
          candidate({
            type: "decision",
            judgment: { relevant: 0.9, governs: 0.85 },
          }),
        ]),
        [
          link({
            origin: "rule",
            role: "context",
            evidence: { basis: "retrieval" },
          }),
        ],
        AUTO_APPLY_OFF,
      ),
    ).map((write) => [
      write.role,
      write.origin,
      write.status,
      write.confidence,
    ]),
    [
      ["context", "rule", "retracted", 0.9],
      ["decision", "consolidator", "suggested", 0.85],
    ],
  );
  assert.deepEqual(
    only(
      planJevLinks(
        analysis([candidate({ judgment: { relevant: 0.3 } })]),
        [
          link({
            origin: "rule",
            confidence: null,
            evidence: { basis: "retrieval" },
          }),
        ],
        AUTO_APPLY_OFF,
      ),
    ).map((write) => [write.origin, write.status, write.confidence]),
    [["rule", "suggested", 0.3]],
  );
  // A decided_in suggestion keeps its rule origin and gains the decision score;
  // a context verdict never adds a second live role to the page.
  assert.deepEqual(
    only(
      planJevLinks(
        analysis([
          candidate({
            type: "decision",
            judgment: { relevant: 0.9, governs: 0.4 },
          }),
        ]),
        [
          link({
            origin: "rule",
            role: "decision",
            evidence: { basis: "decided_in" },
          }),
        ],
        AUTO_APPLY_OFF,
      ),
    ).map((write) => [
      write.role,
      write.origin,
      write.status,
      write.confidence,
    ]),
    [["decision", "rule", "suggested", 0.4]],
  );
  // An owner-accepted rule link is decided and out of reach.
  assert.deepEqual(
    planJevLinks(
      analysis([candidate()]),
      [
        link({
          origin: "rule",
          status: "suggested",
          decidedAt: "2026-10-20T00:00:00.000Z",
          evidence: { basis: "retrieval" },
        }),
      ],
      AUTO_APPLY_OFF,
    ),
    [],
  );
});

test("planning a unit again over its own result writes the same rows; a returning unit re-suggests what another retracted", () => {
  // Rows as written by the first plan, so a later run's plan is a no-op.
  const asRows = (writes: MachineLinkWrite[]): ExistingTaskLink[] =>
    writes.map((write) => link({ ...write, decidedAt: null }));
  const upgraded = planJevLinks(
    analysis([candidate()]),
    [
      link({
        origin: "rule",
        confidence: null,
        evidence: { basis: "retrieval" },
      }),
    ],
    AUTO_APPLY_OFF,
  );
  assert.equal(upgraded[0].evidence.previousBasis, "retrieval");
  assert.deepEqual(
    planJevLinks(analysis([candidate()]), asRows(upgraded), AUTO_APPLY_OFF),
    upgraded,
  );
  // Night 2: a title edit (another unit) scores the page below 0.50 and
  // retracts it. Night 3 reverts the title: the first unit comes back.
  const edited: LinkAnalysis = {
    ...analysis([candidate({ judgment: { relevant: 0.2 } })]),
    unitId: "v".repeat(64),
    taskFingerprint: "b".repeat(64),
  };
  const retracted = planJevLinks(edited, asRows(upgraded), AUTO_APPLY_OFF);
  assert.deepEqual(
    only(retracted).map((write) => write.status),
    ["retracted"],
  );
  assert.deepEqual(
    only(
      planJevLinks(analysis([candidate()]), asRows(retracted), AUTO_APPLY_OFF),
    ),
    [
      {
        pageId: uuid(1),
        role: "context",
        origin: "consolidator",
        status: "suggested",
        confidence: 0.9,
      },
    ],
  );
});

test("the Jev queue puts tasks with changed inputs first, so the cap never starves the tail", () => {
  const inputs = (taskFingerprint: string, corpus = "c1") =>
    linkInputsFingerprint({
      policyVersion: "task-linker-v1:p:1",
      taskFingerprint,
      corpus,
      vectorModel: "openai/text-embedding-3-small",
    });
  assert.match(inputs("a"), /^[a-f0-9]{64}$/);
  assert.notEqual(inputs("a"), inputs("b"));
  assert.notEqual(inputs("a"), inputs("a", "c2"));
  assert.notEqual(
    inputs("a"),
    linkInputsFingerprint({
      policyVersion: "task-linker-v1:p:1",
      taskFingerprint: "a",
      corpus: "c1",
      vectorModel: null,
    }),
  );
  const tasks = Array.from({ length: 7 }, (_, index) => ({
    id: `t${index}`,
    inputs: inputs(`t${index}`),
  }));
  const done = new Map<string, CompletedPass>();
  const complete = (ids: string[], at: number, corpus = "c1") => {
    for (const id of ids) done.set(id, { inputs: inputs(id, corpus), at });
  };
  // Night 1: nothing completed yet; the queue order holds and 3 are left.
  const first = jevQueue(tasks, done, 4);
  assert.deepEqual(first.taskIds, ["t0", "t1", "t2", "t3"]);
  assert.equal(first.remainingTasks, 3);
  complete(first.taskIds, 1);
  // Night 2: the tail comes first; unchanged tasks only fill the free slots.
  const second = jevQueue(tasks, done, 4);
  assert.deepEqual(second.taskIds, ["t4", "t5", "t6", "t0"]);
  assert.equal(second.remainingTasks, 0);
  complete(["t4", "t5", "t6"], 2);
  // An edit makes one task stale again; current tasks wait behind it.
  done.set("t2", { inputs: inputs("t2", "c0"), at: 1 });
  assert.deepEqual(jevQueue(tasks, done, 2).taskIds, ["t2", "t0"]);
  // The corpus changes every night: every task is stale, and the cap takes
  // the least recently completed ones, so each is reached within two nights.
  const nights: string[][] = [];
  for (const [night, corpus] of ["c2", "c3", "c4"].entries()) {
    const changed = tasks.map((task) => ({
      id: task.id,
      inputs: inputs(task.id, corpus),
    }));
    const queue = jevQueue(changed, done, 4);
    assert.equal(queue.remainingTasks, 3);
    nights.push(queue.taskIds);
    complete(queue.taskIds, 10 + night, corpus);
  }
  // Ties (completed the same night) go to the queue order.
  assert.deepEqual(nights, [
    ["t0", "t1", "t2", "t3"],
    ["t0", "t4", "t5", "t6"],
    ["t0", "t1", "t2", "t3"],
  ]);
});

test("retraction needs a fingerprint change and a score below 0.50; 0.50–0.80 is left alone", () => {
  const changed = evaluated({ task: "b".repeat(64) });
  const retract = (score: number, evidence: Record<string, unknown>) =>
    only(
      planJevLinks(
        analysis([candidate({ judgment: { relevant: score } })]),
        [link({ evidence })],
        AUTO_APPLY_OFF,
      ),
    );
  assert.deepEqual(retract(0.45, changed), [
    {
      pageId: uuid(1),
      role: "context",
      origin: "consolidator",
      status: "retracted",
      confidence: 0.45,
    },
  ]);
  assert.deepEqual(
    retract(0.45, evaluated({ page: "q".repeat(64) }))[0].status,
    "retracted",
  );
  assert.deepEqual(retract(0.6, changed), []);
  assert.deepEqual(retract(0.79, changed), []);
  assert.deepEqual(retract(0.3, evaluated()), []);
  // Back above 0.80: a retracted consolidator link is proposed again.
  assert.deepEqual(
    only(
      planJevLinks(
        analysis([candidate({ judgment: { relevant: 0.95 } })]),
        [link({ status: "retracted", evidence: changed })],
        AUTO_APPLY_OFF,
      ),
    )[0].status,
    "suggested",
  );
  // A decision link rests on both questions.
  assert.deepEqual(
    only(
      planJevLinks(
        analysis([
          candidate({
            type: "decision",
            judgment: { relevant: 0.9, governs: 0.2 },
          }),
        ]),
        [link({ role: "decision", evidence: changed })],
        AUTO_APPLY_OFF,
      ),
    ).map((write) => [write.role, write.status]),
    // Still relevant as context once the decision role is retracted.
    [
      ["decision", "retracted"],
      ["context", "suggested"],
    ],
  );
});

test("the auto-apply gate is off at release and opens a role only when every threshold holds", () => {
  assert.deepEqual(TASK_LINK_AUTO_APPLY, {
    context: false,
    stakeholder: false,
    decision: false,
  });
  const good: RoleReviewMetrics = {
    reviews: 40,
    accepted: 38,
    rejected: 2,
    acceptance: 0.95,
    recentReviews: 20,
    recentRejected: 1,
    recentRejectionRate: 0.05,
  };
  const defaults = roleGate("context", good);
  assert.equal(defaults.enabled, false);
  assert.deepEqual(defaults.reasons, ["switch_off", "benchmark_precision"]);
  const open = roleGate("context", good, {
    switchOn: true,
    benchmarkPrecision: 0.93,
  });
  assert.equal(open.enabled, true);
  assert.deepEqual(open.reasons, []);
  assert.deepEqual(
    roleGate(
      "context",
      { ...good, reviews: 29 },
      { switchOn: true, benchmarkPrecision: 0.93 },
    ).reasons,
    ["owner_reviews"],
  );
  assert.deepEqual(
    roleGate(
      "context",
      { ...good, acceptance: 0.79 },
      { switchOn: true, benchmarkPrecision: 0.93 },
    ).reasons,
    ["acceptance"],
  );
  assert.deepEqual(
    roleGate("stakeholder", good, { switchOn: true, benchmarkPrecision: 0.89 })
      .reasons,
    ["benchmark_precision"],
  );
  const killed = roleGate(
    "context",
    { ...good, recentRejected: 3, recentRejectionRate: 0.15 },
    { switchOn: true, benchmarkPrecision: 0.95 },
  );
  assert.equal(killed.killed, true);
  assert.deepEqual(killed.reasons, ["kill_switch"]);
  assert.ok(AUTO_APPLY_THRESHOLDS.killRejectionRate === 0.1);
  assert.deepEqual(autoApplyState([open, killed]), {
    context: true,
    stakeholder: false,
    decision: false,
  });
  // With a role open, new links of that role are applied; decision only in the decided_in neighbourhood.
  const on = { context: true, stakeholder: false, decision: true };
  assert.equal(
    planJevLinks(analysis([candidate()]), [], on)[0].status,
    "active",
  );
  const decision = (source: AnalyzedCandidate["source"]) =>
    planJevLinks(
      analysis([
        candidate({
          type: "decision",
          source,
          judgment: { relevant: 0.9, governs: 0.9 },
        }),
      ]),
      [],
      on,
    )[0].status;
  assert.equal(decision("decided_in"), "active");
  assert.equal(decision("retrieval"), "suggested");
});

test("rules add missing links, re-propose retracted machine rows and retract stale undecided ones", () => {
  const desired: MachineLinkWrite[] = [
    {
      pageId: uuid(1),
      role: "decision",
      origin: "rule",
      status: "suggested",
      confidence: null,
      evidence: { basis: "decided_in" },
    },
    {
      pageId: uuid(2),
      role: "context",
      origin: "rule",
      status: "active",
      confidence: null,
      evidence: { basis: "reference", mention: true },
    },
    {
      pageId: uuid(3),
      role: "context",
      origin: "rule",
      status: "active",
      confidence: null,
      evidence: { basis: "reference" },
    },
  ];
  const writes = planRuleLinks(desired, [
    link({ pageId: uuid(2), origin: "agent", status: "active" }),
    link({ pageId: uuid(3), origin: "consolidator", status: "retracted" }),
    link({
      pageId: uuid(4),
      role: "decision",
      origin: "rule",
      evidence: { basis: "decided_in" },
    }),
    link({
      pageId: uuid(5),
      role: "decision",
      origin: "rule",
      status: "active",
      decidedAt: "2026-10-20T00:00:00.000Z",
      evidence: { basis: "decided_in" },
    }),
    link({
      pageId: uuid(6),
      role: "context",
      origin: "rule",
      status: "active",
      evidence: { basis: "reference", mention: true },
    }),
    link({ pageId: uuid(7), origin: "rule", evidence: { basis: "retrieval" } }),
  ]);
  // A mention promotes a pending retrieval suggestion, and skips a page
  // already active in another role.
  const mention = (pageId: string): MachineLinkWrite => ({
    pageId,
    role: "context",
    origin: "rule",
    status: "active",
    confidence: null,
    evidence: { basis: "reference", mention: true },
  });
  assert.deepEqual(
    planRuleLinks(
      [mention(uuid(7)), mention(uuid(8))],
      [
        link({
          pageId: uuid(7),
          origin: "rule",
          evidence: { basis: "retrieval" },
        }),
        link({
          pageId: uuid(8),
          role: "source",
          origin: "task_keeper",
          status: "active",
        }),
      ],
    ).map((write) => [write.pageId, write.status]),
    [[uuid(7), "active"]],
  );
  assert.deepEqual(
    writes.map((write) => [write.pageId, write.role, write.status]),
    [
      [uuid(1), "decision", "suggested"],
      [uuid(3), "context", "active"],
      [uuid(4), "decision", "retracted"],
      [uuid(6), "context", "retracted"],
    ],
  );
});

test("retrieval suggests the first five unlinked results and retracts undecided ones beyond ten", () => {
  const results = Array.from({ length: 12 }, (_, index) => ({
    id: uuid(index + 1),
    version: 1,
  }));
  const existing = [
    link({ pageId: uuid(1), origin: "owner", status: "active" }),
    link({
      pageId: uuid(3),
      origin: "rule",
      status: "rejected",
      evidence: { basis: "retrieval" },
      decidedAt: "2026-10-20T00:00:00.000Z",
    }),
    link({ pageId: uuid(4), origin: "rule", evidence: { basis: "retrieval" } }),
    link({ pageId: uuid(9), origin: "rule", evidence: { basis: "retrieval" } }),
    link({
      pageId: uuid(12),
      origin: "rule",
      evidence: { basis: "retrieval" },
    }),
    link({
      pageId: uuid(20),
      origin: "rule",
      evidence: { basis: "retrieval" },
    }),
    link({
      pageId: uuid(21),
      origin: "rule",
      status: "active",
      decidedAt: "2026-10-20T00:00:00.000Z",
      evidence: { basis: "retrieval" },
    }),
    link({
      pageId: uuid(6),
      origin: "rule",
      status: "retracted",
      evidence: { basis: "retrieval" },
    }),
  ];
  const plan = planRetrieval(results, existing, [uuid(2)]);
  assert.deepEqual(
    plan.suggest.map((item) => [item.pageId, item.rank]),
    [
      [uuid(4), 4],
      [uuid(5), 5],
      [uuid(6), 6],
      [uuid(7), 7],
      [uuid(8), 8],
    ],
  );
  assert.deepEqual(plan.retract, [
    { pageId: uuid(12), reason: "outside_top_10" },
    { pageId: uuid(20), reason: "outside_top_10" },
  ]);
  // A suggestion whose page gained another live link steps aside.
  assert.deepEqual(
    planRetrieval(results, [
      link({
        pageId: uuid(4),
        origin: "rule",
        evidence: { basis: "retrieval" },
      }),
      link({
        pageId: uuid(4),
        role: "decision",
        origin: "rule",
        evidence: { basis: "decided_in" },
      }),
    ]).retract,
    [{ pageId: uuid(4), reason: "linked_otherwise" }],
  );
  const writes = retrievalWrites(plan, existing, "sync");
  assert.deepEqual(
    writes.map((write) => [write.pageId, write.status]),
    [
      [uuid(5), "suggested"],
      [uuid(6), "suggested"],
      [uuid(7), "suggested"],
      [uuid(8), "suggested"],
      [uuid(12), "retracted"],
      [uuid(20), "retracted"],
    ],
  );
  assert.equal(writes[0].evidence.basis, "retrieval");
  assert.equal(writes[0].origin, "rule");
});

test("the brief cites the project, then active links by role, then suggestions by confidence", () => {
  const brief = (
    pageId: string,
    role: string,
    status: string,
    confidence: number | null,
  ) => ({
    pageId,
    slug: pageId,
    title: pageId,
    role,
    origin: "rule",
    status,
    confidence,
  });
  const links = [
    brief("s-low", "context", "suggested", 0.81),
    brief("a-context", "context", "active", null),
    brief("s-high", "decision", "suggested", 0.95),
    brief("a-source", "source", "active", null),
    brief("p-suggested", "produced", "suggested", null),
    brief("a-source", "context", "active", null),
  ];
  assert.deepEqual(
    orderBriefLinks(links).map((item) => item.pageId),
    ["a-source", "a-context", "s-high", "s-low"],
  );
  assert.deepEqual(
    briefRefs({
      ownerId: "o",
      ref: "T-1",
      title: "T",
      acceptanceCriteria: [],
      projectPageId: "project",
      linkedPageIds: [],
      links: [
        ...links,
        ...Array.from({ length: 12 }, (_, index) =>
          brief(`x${index}`, "context", "suggested", 0.5),
        ),
      ],
      history: [],
    }).slice(0, 5),
    ["project", "a-source", "a-context", "s-high", "s-low"],
  );
});

test("excerpts are bounded and fall back to the page opening", () => {
  const markdown = "x".repeat(5000);
  assert.deepEqual(
    {
      ...excerptFor(markdown, { startOffset: 100, endOffset: 4000 }),
      text: undefined,
    },
    { text: undefined, startOffset: 100, endOffset: 1300 },
  );
  assert.equal(
    excerptFor(markdown, { startOffset: 0, endOffset: 0 }).startOffset,
    0,
  );
  assert.equal(excerptFor("short").text, "short");
});

test("the committed task_relevance benchmark has ≥30 labelled Italian cases in every category", async () => {
  const dataset = benchmarkSchema.parse(
    JSON.parse(
      await readFile(
        resolve(
          import.meta.dirname,
          "../docs/benchmarks/2026-10-21-task-relevance/dataset.json",
        ),
        "utf8",
      ),
    ),
  );
  const cases = dataset.scenarios.flatMap((scenario) => scenario.pages);
  assert.ok(cases.length >= 30);
  for (const scenario of dataset.scenarios) {
    const request = benchmarkRequest(scenario);
    assert.ok(Object.keys(request.questions).length <= 24);
  }
  const predictions: CasePrediction[] = [
    {
      id: "1",
      category: "decisione_pertinente",
      expected: "decision",
      predicted: "decision",
      judgment: { relevant: 1 },
    },
    {
      id: "2",
      category: "decisione_superata",
      expected: "none",
      predicted: "decision",
      judgment: { relevant: 1 },
    },
    {
      id: "3",
      category: "stakeholder",
      expected: "stakeholder",
      predicted: "context",
      judgment: { relevant: 1 },
    },
    {
      id: "4",
      category: "menzione_incidentale",
      expected: "none",
      predicted: "none",
      judgment: { relevant: 0 },
    },
  ];
  const metrics = benchmarkMetrics(predictions);
  assert.equal(metrics.roles.decision.precision, 0.5);
  assert.equal(metrics.roles.decision.recall, 1);
  assert.equal(metrics.roles.stakeholder.recall, 0);
  assert.equal(metrics.linkDetection.precision, 2 / 3);
  assert.equal(metrics.categories.menzione_incidentale.accuracy, 1);
});
