import assert from "node:assert/strict";
import test from "node:test";
import {
  delegateOptions,
  unavailableDelegateNote,
} from "../components/tasks/delegates";
import { dueInput, initialDue } from "../components/tasks/due";
import {
  dueDay,
  dueLabel,
  ownerWallTime,
  ownerWallToIso,
} from "../components/tasks/labels";
import {
  BOARD_COLUMNS,
  boardMove,
  boardMoveTargets,
  MENU_TARGETS,
  MOVE_INPUT,
  moveAnnouncement,
  suggestedTransition,
  suggestionConflict,
  taskChange,
} from "../components/tasks/transitions";
import { LIVE_REFRESH_MS } from "../hooks/use-live-refresh";
import { TASK_STATUSES } from "../lib/tasks/types";

const approved = (status: string) => ({ status, approved: true });
const unapproved = (status: string) => ({ status, approved: false });

test("board moves map to the owner transitions of §6.2", () => {
  assert.equal(boardMove(unapproved("triage"), "ready"), "approve");
  assert.equal(boardMove(unapproved("triage"), "in_progress"), "start");
  assert.equal(boardMove(approved("ready"), "in_progress"), "start");
  assert.equal(boardMove(approved("ready"), "blocked"), "block");
  assert.equal(boardMove(approved("in_progress"), "ready"), "release");
  assert.equal(boardMove(approved("needs_input"), "ready"), "release");
  // An on-request claim of an unapproved task returns where it started.
  assert.equal(boardMove(unapproved("in_progress"), "triage"), "release");
  assert.equal(boardMove(unapproved("in_progress"), "ready"), "release");
  assert.equal(boardMove(approved("in_progress"), "triage"), null);
  assert.equal(boardMove(approved("blocked"), "ready"), "unblock");
  assert.equal(boardMove(unapproved("blocked"), "triage"), "unblock");
  assert.equal(boardMove(unapproved("blocked"), "ready"), null);
  assert.equal(boardMove(approved("on_hold"), "ready"), "resume");
  assert.equal(boardMove(approved("in_review"), "done"), "review_approve");
  assert.equal(boardMove(approved("in_review"), "ready"), "request_changes");
  assert.equal(boardMove(approved("ready"), "done"), "close");
  assert.equal(boardMove(approved("done"), "ready"), "reopen");
  assert.equal(boardMove(unapproved("canceled"), "triage"), "reopen");
  assert.equal(boardMove(approved("in_progress"), "canceled"), "cancel");
  assert.equal(boardMove(approved("blocked"), "on_hold"), "hold");
  assert.equal(boardMove(approved("on_hold"), "on_hold"), null);
});

test("the holder's states are never a drop target, nor reachable from terminal states", () => {
  for (const status of TASK_STATUSES) {
    assert.equal(boardMove(approved(status), "needs_input"), null, status);
    assert.equal(boardMove(approved(status), "in_review"), null, status);
    assert.equal(boardMove(approved(status), status), null, status);
  }
  assert.deepEqual(
    boardMoveTargets(approved("done"), TASK_STATUSES).map(
      (move) => move.status,
    ),
    ["ready"],
  );
  assert.deepEqual(
    boardMoveTargets(approved("blocked"), TASK_STATUSES).map((move) => move.op),
    ["unblock", "hold", "close", "cancel"],
  );
  assert.equal(MOVE_INPUT.block, "reason");
  assert.equal(MOVE_INPUT.request_changes, "note");
  assert.equal(MOVE_INPUT.approve, undefined);
});

test("accepted suggestions run only a recognised, prefilled transition", () => {
  assert.deepEqual(
    suggestedTransition({
      kind: "may_be_done",
      payload: { transition: { op: "close", note: "Verbale 20/10: fatto" } },
    }),
    { op: "close", note: "Verbale 20/10: fatto" },
  );
  assert.deepEqual(
    suggestedTransition({
      kind: "duplicate",
      payload: { action: "Cancelled" },
    }),
    { op: "cancel" },
  );
  assert.deepEqual(suggestedTransition({ kind: "stale_claim", payload: {} }), {
    op: "release",
  });
  assert.deepEqual(
    suggestedTransition({
      kind: "new_source",
      payload: {},
      citations: [
        { excerpt: "…" },
        { pageId: "note/verbale-20-10", version: 3 },
      ],
    }),
    { op: "link", pageRef: "note/verbale-20-10", role: "source" },
  );
  assert.deepEqual(
    suggestedTransition({
      kind: "decision_superseded",
      payload: {
        transition: { op: "link", pageRef: "decision/x", role: "decision" },
      },
    }),
    { op: "link", pageRef: "decision/x", role: "decision" },
  );
  // Unknown or unsafe proposals only record the decision.
  for (const payload of [
    {},
    { transition: { op: "purge" } },
    { transition: { op: "link", pageRef: "x", role: "produced" } },
    { transition: { op: "approve" } },
    null,
    "close",
  ])
    assert.equal(
      suggestedTransition({ kind: "overdue_no_outcome", payload }),
      null,
      JSON.stringify(payload),
    );
  assert.equal(
    suggestedTransition({ kind: "new_source", payload: {}, citations: [] }),
    null,
  );
});

test("every drag-and-drop move is also offered by the keyboard Move to… menu", () => {
  // Release criterion 12: the board and its menu share one transition table.
  for (const status of TASK_STATUSES)
    for (const isApproved of [true, false]) {
      const task = { status, approved: isApproved };
      const dropped = boardMoveTargets(task, BOARD_COLUMNS);
      const menu = boardMoveTargets(task, MENU_TARGETS);
      for (const move of dropped)
        assert.ok(
          menu.some(
            (item) => item.status === move.status && item.op === move.op,
          ),
          `${status}/${isApproved} → ${move.status}`,
        );
      assert.deepEqual(
        menu.filter((item) => item.status !== "canceled"),
        dropped,
      );
    }
  assert.ok(MENU_TARGETS.includes("canceled"));
  assert.ok(!BOARD_COLUMNS.includes("canceled"));
});

test("open task views poll for changes well within 15 seconds", () => {
  assert.ok(LIVE_REFRESH_MS <= 15_000);
});

test("the task keeper's suggestion payloads map to the owner transitions", () => {
  // Payload shapes written by lib/maintenance/task-keeper (hygiene.ts, apply.ts).
  const page = { pageId: "11111111-1111-4111-8111-111111111111" };
  const cases: [string, Record<string, unknown>, unknown][] = [
    [
      "may_be_done",
      { action: "close", state: "done", ...page, pageVersion: 4 },
      { op: "close" },
    ],
    [
      "may_be_done",
      { action: "cancel", state: "canceled", ...page, pageVersion: 4 },
      { op: "cancel" },
    ],
    [
      "may_be_done",
      { action: "reschedule", state: "rescheduled", ...page, pageVersion: 4 },
      null,
    ],
    [
      "stale_claim",
      {
        action: "force_release",
        holderAgentId: "22222222-2222-4222-8222-222222222222",
        leaseExpiredAt: "2026-10-20T08:00:00Z",
      },
      { op: "release" },
    ],
    [
      "new_source",
      {
        action: "link",
        role: "source",
        ...page,
        pageVersion: 3,
        startOffset: 10,
        endOffset: 80,
        title: "Inviare il report",
        actorNames: ["Damato"],
      },
      { op: "link", pageRef: page.pageId, role: "source" },
    ],
    [
      "overdue_no_outcome",
      { action: "review_due", options: ["reschedule", "close", "cancel"] },
      null,
    ],
    ["triage_aging", { action: "approve_or_cancel" }, null],
    [
      "decision_superseded",
      {
        action: "review_decision_links",
        supersededPageId: page.pageId,
        supersedingPageId: "33333333-3333-4333-8333-333333333333",
      },
      null,
    ],
    [
      "criterion_evidence",
      { action: "review_criterion", criterionIndex: 0, criterion: "QA GO" },
      null,
    ],
    [
      "divergent_state",
      { action: "review_sources", sources: [{ ...page, pageVersion: 2 }] },
      null,
    ],
    ["duplicate", { action: "merge", keepRef: "T-3", mergeRef: "T-9" }, null],
  ];
  for (const [kind, payload, expected] of cases)
    assert.deepEqual(
      suggestedTransition({ kind, payload }),
      expected,
      `${kind}:${String(payload.action)}`,
    );
});

test("due inputs follow the typed due schema", () => {
  const base = { date: "", time: "", text: "" };
  assert.deepEqual(dueInput({ ...base, kind: "unset" }), {
    due: { kind: "unset" },
  });
  assert.deepEqual(dueInput({ ...base, kind: "date", date: "2026-10-16" }), {
    due: { kind: "date", on: "2026-10-16" },
  });
  assert.ok("error" in dueInput({ ...base, kind: "date" }));
  assert.deepEqual(
    dueInput({ ...base, kind: "datetime", date: "2026-10-16", time: "09:30" }),
    { due: { kind: "datetime", at: "2026-10-16T07:30:00.000Z" } },
  );
  assert.ok(
    "error" in dueInput({ ...base, kind: "datetime", date: "2026-10-16" }),
  );
  assert.deepEqual(
    dueInput({ ...base, kind: "event", text: " next steering meeting " }),
    { due: { kind: "event", text: "next steering meeting" } },
  );
  assert.deepEqual(
    dueInput({
      ...base,
      kind: "approximate",
      text: "~30/10",
      date: "2026-10-30",
    }),
    { due: { kind: "approximate", text: "~30/10", on: "2026-10-30" } },
  );
  assert.ok("error" in dueInput({ ...base, kind: "approximate" }));
  assert.deepEqual(dueInput({ ...base, kind: "hard", date: "2026-11-02" }), {
    due: { kind: "hard", on: "2026-11-02" },
  });
  assert.deepEqual(
    dueInput({ ...base, kind: "hard", date: "2026-11-02", time: "18:00" }),
    { due: { kind: "hard", at: "2026-11-02T17:00:00.000Z" } },
  );
  // Editing starts from the stored value on the owner's clock.
  assert.deepEqual(
    initialDue({
      kind: "datetime",
      on: null,
      at: "2026-10-16T07:30:00.000Z",
      text: null,
    }),
    { kind: "datetime", date: "2026-10-16", time: "09:30", text: "" },
  );
  assert.deepEqual(
    initialDue({ kind: "weird", on: null, at: null, text: "x" }),
    {
      kind: "unset",
      date: "",
      time: "",
      text: "x",
    },
  );
});

test("owner wall times convert across daylight saving changes", () => {
  assert.equal(
    ownerWallToIso("2026-07-01", "12:00"),
    "2026-07-01T10:00:00.000Z",
  );
  assert.equal(
    ownerWallToIso("2026-01-15", "12:00"),
    "2026-01-15T11:00:00.000Z",
  );
  // The night DST ends (25 October 2026, 03:00 → 02:00).
  assert.equal(
    ownerWallToIso("2026-10-25", "04:00"),
    "2026-10-25T03:00:00.000Z",
  );
  assert.deepEqual(ownerWallTime("2026-10-24T22:30:00.000Z"), {
    date: "2026-10-25",
    time: "00:30",
  });
  // A due time late in the evening UTC falls on the next day in Rome.
  assert.equal(
    dueDay({ on: null, at: "2026-10-31T23:30:00.000Z" }),
    "2026-11-01",
  );
  assert.equal(dueDay({ on: "2026-10-16", at: null }), "2026-10-16");
  assert.equal(dueDay({ on: null, at: null }), null);
});

test("due labels keep the original wording first", () => {
  assert.equal(
    dueLabel({ kind: "unset", on: null, at: null, text: null }),
    null,
  );
  assert.equal(
    dueLabel({ kind: "date", on: "2026-10-16", at: null, text: null }),
    "16 Oct 2026",
  );
  assert.equal(
    dueLabel({
      kind: "event",
      on: null,
      at: null,
      text: { value: "prossima riunione" },
    }),
    "prossima riunione",
  );
  assert.equal(
    dueLabel({
      kind: "hard",
      on: "2026-11-02",
      at: null,
      text: { value: "entro il 2/11" },
    }),
    "Hard deadline: entro il 2/11 · 2 Nov 2026",
  );
  assert.match(
    dueLabel({
      kind: "datetime",
      on: null,
      at: "2026-10-16T07:30:00.000Z",
      text: null,
    }) ?? "",
    /16 Oct 2026, 09:30/,
  );
});

test("an owner action is refused when the task's claim or question changed", () => {
  const current = {
    status: "in_progress",
    version: 4,
    claimCount: 2,
    inputRequestedAt: null,
  };
  assert.equal(taskChange(current, {}), null);
  assert.equal(
    taskChange(current, { status: "in_progress", version: 4, claimCount: 2 }),
    null,
  );
  assert.equal(taskChange(current, { status: "ready" }), "status");
  assert.equal(taskChange(current, { version: 3 }), "version");
  // A takeover of an expired lease keeps status and version (§5).
  assert.equal(
    taskChange(current, { status: "in_progress", version: 4, claimCount: 1 }),
    "claim",
  );
  const asking = {
    ...current,
    status: "needs_input",
    inputRequestedAt: "2026-10-21T08:00:00.000Z",
  };
  assert.equal(
    taskChange(asking, { inputRequestedAt: "2026-10-21T08:00:00Z" }),
    null,
    "the same instant in another notation",
  );
  assert.equal(
    taskChange(asking, { inputRequestedAt: "2026-10-21T07:59:00.000Z" }),
    "question",
  );
  assert.equal(taskChange(asking, { inputRequestedAt: null }), "question");
  assert.equal(taskChange(asking, { inputRequestedAt: "garbage" }), "question");
});

test("a stale claim suggestion applies only to the expired lease it saw", () => {
  const holder = "22222222-2222-4222-8222-222222222222";
  const suggestion = {
    kind: "stale_claim",
    payload: {
      action: "force_release",
      holderAgentId: holder,
      leaseExpiredAt: "2026-10-21T01:30:00.123456Z",
    },
  };
  const task = {
    status: "in_progress",
    archived: false,
    claimedById: holder,
    leaseExpiresAt: "2026-10-21T01:30:00.123456Z",
    leased: true,
    leaseLive: false,
  };
  assert.equal(suggestionConflict(suggestion, "release", task), null);
  assert.equal(
    suggestionConflict(suggestion, "release", { ...task, leaseLive: true }),
    "has a live claim again: its holder renewed it",
  );
  assert.equal(
    suggestionConflict(suggestion, "release", {
      ...task,
      claimedById: "33333333-3333-4333-8333-333333333333",
    }),
    "was taken over by another agent",
  );
  assert.equal(
    suggestionConflict(suggestion, "release", {
      ...task,
      leaseExpiresAt: "2026-10-21T09:00:00.000000Z",
    }),
    "was claimed again",
  );
  assert.equal(
    suggestionConflict(suggestion, "release", {
      ...task,
      status: "ready",
      claimedById: null,
      leaseExpiresAt: null,
      leased: false,
    }),
    "is Ready now",
  );
  assert.equal(
    suggestionConflict(suggestion, "release", {
      ...task,
      status: "needs_input",
      leaseExpiresAt: null,
    }),
    "is waiting for your answer to its holder's question",
  );
  // Older payloads recorded the expiry to the second.
  assert.equal(
    suggestionConflict(
      {
        ...suggestion,
        payload: {
          holderAgentId: holder,
          leaseExpiredAt: "2026-10-21T01:30:00Z",
        },
      },
      "release",
      task,
    ),
    null,
  );
  assert.equal(
    suggestionConflict(suggestion, "release", { ...task, archived: true }),
    "was archived",
  );
  // Other kinds only need the transition to be possible.
  const done = { kind: "may_be_done", payload: { action: "close" } };
  assert.equal(
    suggestionConflict(done, "close", { ...task, leaseLive: true }),
    null,
  );
  assert.equal(
    suggestionConflict(done, "close", { ...task, status: "done" }),
    "is Done now",
  );
  assert.equal(
    suggestionConflict(done, "hold", { ...task, status: "on_hold" }),
    "is On hold now",
  );
});

test("the board announces where the server put a moved task", () => {
  assert.equal(
    moveAnnouncement("T-9", "ready", "ready"),
    "T-9 moved to Ready.",
  );
  // An unapproved claim dropped on Ready returns to Triage.
  assert.equal(
    moveAnnouncement("T-9", "ready", "triage"),
    "T-9 returned to Triage, where its claim started.",
  );
});

test("a disabled delegate stays visible in the delegate select", () => {
  const agents = [
    { id: "a1", label: "Claude Code", labelVerified: true },
    { id: "a2", label: "Cursor", labelVerified: false },
  ];
  assert.deepEqual(delegateOptions(agents, { id: null, label: null }), [
    { value: "", label: "Any suitable agent" },
    { value: "a1", label: "Claude Code" },
    { value: "a2", label: "Cursor (unverified name)" },
  ]);
  assert.equal(
    delegateOptions(agents, { id: "a1", label: "Claude Code" }).length,
    3,
  );
  const options = delegateOptions(agents, { id: "a3", label: "Codex" });
  assert.deepEqual(options[1], {
    value: "a3",
    label: "Codex (disabled)",
    unavailable: true,
  });
  assert.match(
    unavailableDelegateNote(options, "a3") ?? "",
    /no agent can claim/,
  );
  assert.equal(unavailableDelegateNote(options, "a1"), null);
  assert.equal(unavailableDelegateNote(options, ""), null);
});
