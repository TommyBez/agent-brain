import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  addConfirmed,
  CONFIRMED_PAGE_LIMIT,
  confirmedLinks,
  draftChanged,
  fromOtherProject,
  removeConfirmed,
  suggestionSummary,
} from "../components/tasks/page-suggestions";
import type { PageCandidate } from "../lib/tasks/link-candidates";
import { suggestionRequest } from "../lib/tasks/suggestion-request";

const page = (
  pageRef: string,
  role: PageCandidate["role"] = "context",
): PageCandidate => ({
  pageRef,
  slug: pageRef,
  title: `Page ${pageRef}`,
  role,
  reason: "Relevant",
  score: 0.8,
});

test("typing after Suggest pages marks the snapshot stale without changing the request", () => {
  const snapshot = { title: "Plan launch", description: "Draft" };
  const before = JSON.stringify(
    suggestionRequest("T-1", snapshot, "project-a"),
  );
  assert.equal(draftChanged(snapshot, { ...snapshot }), false);
  assert.equal(
    draftChanged(snapshot, { title: "Plan launch ", description: "Draft" }),
    false,
  );
  assert.equal(
    draftChanged(snapshot, { title: "Plan launch v2", description: "Draft" }),
    true,
  );
  assert.equal(
    draftChanged(snapshot, { title: "Plan launch", description: "Draft 2" }),
    true,
  );
  // The request comes from the snapshot, so live edits cannot change it.
  assert.equal(
    JSON.stringify(suggestionRequest("T-1", snapshot, "project-a")),
    before,
  );
  assert.notEqual(
    JSON.stringify(suggestionRequest("T-1", snapshot, "project-b")),
    before,
  );
});

test("confirmed pages keep their role and split into context and decision links", () => {
  const confirmed = addConfirmed(
    [],
    [page("a"), page("d", "decision")],
    "project-a",
  );
  assert.deepEqual(
    confirmed.map((item) => [item.pageRef, item.role, item.projectRef]),
    [
      ["a", "context", "project-a"],
      ["d", "decision", "project-a"],
    ],
  );
  assert.deepEqual(confirmedLinks(confirmed), {
    contextPageRefs: ["a"],
    decisionPageRefs: ["d"],
  });
});

test("confirming a page again replaces it instead of duplicating it", () => {
  const first = addConfirmed([], [page("a")], "project-a");
  const again = addConfirmed(first, [page("a", "decision")], "project-b");
  assert.equal(again.length, 1);
  assert.equal(again[0].role, "decision");
  assert.equal(again[0].projectRef, "project-b");
});

test("removing confirmed pages drops only those pages", () => {
  const confirmed = addConfirmed([], [page("a"), page("b"), page("c")], null);
  assert.deepEqual(
    removeConfirmed(confirmed, ["b"]).map((item) => item.pageRef),
    ["a", "c"],
  );
  assert.deepEqual(removeConfirmed(confirmed, ["a", "b", "c"]), []);
});

test("pages from a previous project are flagged after the project changes", () => {
  const confirmed = [
    ...addConfirmed([], [page("a")], "project-a"),
    ...addConfirmed([], [page("b")], "project-b"),
  ];
  assert.deepEqual(
    fromOtherProject(confirmed, "project-b").map((item) => item.pageRef),
    ["a"],
  );
  assert.deepEqual(
    fromOtherProject(confirmed, null).map((item) => item.pageRef),
    ["a", "b"],
  );
  assert.equal(CONFIRMED_PAGE_LIMIT, 10);
});

test("the live region summarizes results, proposals and the optional status", () => {
  assert.equal(
    suggestionSummary({ kind: "pages", candidates: [] }),
    "No matching pages.",
  );
  assert.equal(
    suggestionSummary({
      kind: "pages",
      candidates: [page("a"), page("d", "decision")],
    }),
    "2 pages suggested, 1 decision.",
  );
  assert.equal(
    suggestionSummary({
      kind: "pages",
      candidates: [page("a")],
      status: "deterministic",
    }),
    "1 page suggested. Ranked without evaluation because it was unavailable.",
  );
  assert.equal(
    suggestionSummary({
      kind: "pages",
      candidates: [page("a")],
      status: "evaluated",
    }),
    "1 page suggested.",
  );
  assert.match(
    suggestionSummary({
      kind: "project",
      candidates: [],
      projectProposal: {
        candidates: [
          {
            projectRef: "p",
            slug: "p",
            title: "P",
            reason: "Recent",
            score: null,
          },
        ],
        preselectedProjectRef: null,
        status: "evaluated",
      },
    }),
    /^1 project proposed\./,
  );
});

test("the suggestion panel is keyed on the run and request, not on live text", () => {
  const component = readFileSync("components/tasks/suggest-pages.tsx", "utf8");
  assert.match(
    component,
    /suggestionRequest\(taskRef, snapshot, chosenProject\)/,
  );
  assert.doesNotMatch(component, /suggestionRequest\(taskRef, draft/);
  assert.match(component, /<fieldset/);
  assert.match(component, /<legend/);
  assert.match(component, /aria-live="polite"/);
  const form = readFileSync("components/tasks/task-form.tsx", "utf8");
  // The edit form queues confirmed pages for Save instead of linking at once.
  assert.doesNotMatch(form, /addLinkAction/);
  assert.match(form, /contextPageRefs = \{ add: contextPageRefs \}/);
});
