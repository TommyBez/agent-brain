import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  addConfirmed,
  CONFIRMED_PAGE_LIMIT,
  confirmedLinks,
  draftChanged,
  fromOtherProject,
  removeConfirmed,
  suggestionSummary,
  unevaluatedPagesNote,
  unreachableKind,
} from "../components/tasks/page-suggestions";
import { SuggestionResult } from "../components/tasks/suggestion-result";
import type {
  PageCandidate,
  TaskLinkSuggestion,
} from "../lib/tasks/link-candidates";
import type { ProjectCandidate } from "../lib/tasks/project-candidates";
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
  assert.match(component, /aria-live="polite"/);
  const result = readFileSync("components/tasks/suggestion-result.tsx", "utf8");
  assert.match(result, /<fieldset/);
  assert.match(result, /<legend/);
  // The phase comes from the discriminant, never from optional fields.
  for (const source of [component, result])
    assert.doesNotMatch(source, /projectProposal\s*\?|\.projectProposal\?\./);
  const form = readFileSync("components/tasks/task-form.tsx", "utf8");
  // The edit form queues confirmed pages for Save instead of linking at once.
  assert.doesNotMatch(form, /addLinkAction/);
  assert.match(form, /contextPageRefs = \{ add: contextPageRefs \}/);
});

const project = (
  candidates: ProjectCandidate[],
  status: "evaluated" | "deterministic",
  fallbackReason?: "deadline",
): Extract<TaskLinkSuggestion, { kind: "project" }> => ({
  kind: "project",
  candidates: [],
  status,
  ...(fallbackReason ? { fallbackReason } : {}),
  projectProposal: {
    candidates,
    preselectedProjectRef: null,
    status,
    ...(fallbackReason ? { fallbackReason } : {}),
  },
});
const candidateProject: ProjectCandidate = {
  projectRef: "p",
  slug: "p",
  title: "Project P",
  reason: "Recent",
  score: null,
};

test("an empty project phase after the deadline says evaluation timed out", () => {
  const summary = suggestionSummary(project([], "deterministic", "deadline"));
  assert.match(summary, /timed out/);
  assert.match(summary, /Suggest again/);
  assert.match(summary, /set a project on the task/);
  assert.doesNotMatch(summary, /No matching pages/);
  // Either the result or the proposal may carry the deadline.
  const proposalOnly = project([], "deterministic");
  proposalOnly.projectProposal.fallbackReason = "deadline";
  assert.match(suggestionSummary(proposalOnly), /timed out/);
});

test("an empty project phase without a deadline asks for a project on the task", () => {
  assert.equal(
    suggestionSummary(project([], "evaluated")),
    "No matching projects. Set a project on the task to see page suggestions.",
  );
});

test("deterministic project lists say they were ranked without evaluation", () => {
  assert.equal(
    suggestionSummary(project([candidateProject], "deterministic")),
    "1 project proposed. Ranked without evaluation because it was unavailable. Choose a project to see page suggestions.",
  );
  assert.equal(
    suggestionSummary(project([candidateProject], "evaluated")),
    "1 project proposed. Choose a project to see page suggestions.",
  );
});

test("only the pages phase reports no matching pages", () => {
  assert.equal(
    suggestionSummary({ kind: "pages", candidates: [], status: "evaluated" }),
    "No matching pages.",
  );
  assert.equal(
    unevaluatedPagesNote({
      kind: "pages",
      candidates: [page("a")],
      status: "evaluated",
      unevaluatedPageRefs: ["b", "c"],
    }),
    "2 other pages could not be evaluated and are not listed.",
  );
  assert.equal(
    unevaluatedPagesNote({
      kind: "pages",
      candidates: [page("a")],
      status: "deterministic",
      unevaluatedPageRefs: ["a"],
    }),
    null,
  );
});

test("suggestion kinds are handled exhaustively", () => {
  // Adding a kind to TaskLinkSuggestion fails typecheck here and in the switches.
  const kinds = { project: true, pages: true } satisfies Record<
    TaskLinkSuggestion["kind"],
    true
  >;
  assert.deepEqual(Object.keys(kinds), ["project", "pages"]);
  const unknown = { kind: "legacy", candidates: [] } as unknown as never;
  assert.throws(() => unreachableKind(unknown), /Unknown suggestion kind/);
  assert.throws(() => suggestionSummary(unknown), /Unknown suggestion kind/);
});

const renderResult = (
  result: TaskLinkSuggestion,
  onRetry?: () => void,
): string =>
  renderToStaticMarkup(
    createElement(SuggestionResult, {
      result,
      idPrefix: "s",
      pending: false,
      projectChoice: "",
      onProjectChoice: () => {},
      onUseProject: () => {},
      onRetry,
      selected: [],
      onSelect: () => {},
      onConfirmPages: () => {},
      confirmLabel: "Add selected pages",
    }),
  );

test("an empty project phase after the deadline renders the project chooser with a retry", () => {
  const html = renderResult(project([], "deterministic", "deadline"), () => {});
  assert.match(html, /data-phase="project"/);
  assert.match(html, /Choose a project before suggesting pages/);
  assert.match(html, /timed out/);
  assert.match(html, />Suggest again</);
  assert.doesNotMatch(html, /No matching pages/);
  assert.doesNotMatch(html, /data-phase="pages"/);
  // Without a usable draft there is no retry button, only the guidance.
  assert.doesNotMatch(
    renderResult(project([], "deterministic", "deadline")),
    />Suggest again</,
  );
  const noDeadline = renderResult(project([], "evaluated"), () => {});
  assert.match(noDeadline, /No matching projects/);
  assert.doesNotMatch(noDeadline, />Suggest again</);
});

test("the pages phase renders candidates and its empty state", () => {
  const empty = renderResult({ kind: "pages", candidates: [] });
  assert.match(empty, /data-phase="pages"/);
  assert.match(empty, /No matching pages\./);
  assert.doesNotMatch(empty, /Choose a project/);
  const listed = renderResult({
    kind: "pages",
    candidates: [page("a")],
    status: "evaluated",
    unevaluatedPageRefs: ["b"],
  });
  assert.match(listed, /Page a/);
  assert.match(
    listed,
    /1 other page could not be evaluated and is not listed\./,
  );
  assert.match(listed, /Add selected pages/);
});
