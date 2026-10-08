import assert from "node:assert/strict";
import test from "node:test";
import { FakeBrain } from "../scripts/skill-eval/brain";
import { scenarios, validateDataset } from "../scripts/skill-eval/dataset";
import {
  type Session,
  score,
  subjectPrompt,
} from "../scripts/skill-eval/evaluate";

test("isolated Brain executes a decision save and readback; scorer distinguishes structure from meaning", () => {
  validateDataset(scenarios);
  assert.equal(scenarios.length, 20);
  const c = scenarios[0];
  const initial = structuredClone(c.initial);
  const brain = new FakeBrain(initial, {});
  const result = brain.call("write", {
    expectedVersion: 0,
    title: "Hosting gestito per Iris",
    type: "decision",
    markdown:
      "Hosting gestito perché il team non copre le operazioni, accettando un costo maggiore. Non implementato.",
    links: [{ type: "decided_in", targetRef: initial[0].slug, label: "" }],
    reason: "Scelta confermata",
    source: "Conversazione sintetica",
  }) as { id: string };
  brain.call("read", { ref: result.id });
  const session: Session = {
    id: "trial",
    bundle: { files: {}, instructions: "" },
    initial,
    pages: brain.pages,
    trace: brain.trace,
    status: "completed",
    final: "Salvato",
    mode: "loaded",
    model: "gpt-6.1-sol",
    maxCalls: 40,
  };
  assert.equal(score(c, session).structuralPass, true);
  assert.equal(score(c, session).overallPass, null);
  assert.deepEqual(initial, c.initial);
  assert.equal(initial.length, 1);
  assert.equal(brain.pages.length, 2);
  const prompt = subjectPrompt(
    c.request,
    {
      files: {
        "SKILL.md":
          "---\nname: brain-memory\ndescription: retrieve context\n---\nSECRET_BODY",
      },
      instructions: "SERVER",
    },
    "discovery",
    "command",
  );
  assert(!prompt.includes("SECRET_BODY"));
  assert(!prompt.includes(c.expected.content[0]));
  assert(!prompt.includes("Expected new decisions"));
});

test("stale writes and missing links are atomic; missed and unauthorized decisions fail evaluation", () => {
  const c = scenarios[0];
  const brain = new FakeBrain(c.initial, {});
  const initial = structuredClone(brain.pages);
  brain.call("append", {
    ref: c.initial[0].slug,
    expectedVersion: 99,
    markdown: "WRONG",
  });
  brain.call("write", {
    expectedVersion: 0,
    title: "Invalid",
    type: "decision",
    markdown: "WRONG",
    links: [{ type: "decided_in", targetRef: "missing", label: "" }],
  });
  assert.deepEqual(brain.pages, initial);
  assert(brain.trace.every((t) => t.error && !t.mutation));
  const session: Session = {
    id: "trial",
    bundle: { files: {}, instructions: "" },
    initial,
    pages: brain.pages,
    trace: brain.trace,
    status: "completed",
    final: "Done",
    mode: "loaded",
    model: "gpt-6.1-sol",
    maxCalls: 40,
  };
  assert.equal(score(c, session).structuralPass, false);
  brain.call("append", {
    ref: c.initial[0].slug,
    expectedVersion: 1,
    markdown: "Una scelta non autorizzata.",
  });
  assert.equal(brain.pages[0].version, 2);
  const forbidden = scenarios.find((s) => s.id === "N17");
  assert(forbidden);
  assert.equal(
    score(forbidden, session).checks.noUnauthorizedOrRedundantWrites,
    false,
  );
});
