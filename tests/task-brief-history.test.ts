import assert from "node:assert/strict";
import test from "node:test";
import { historySection, type TaskBriefHistoryItem } from "../lib/tasks/brief";

const HISTORY_MAX_CHARACTERS = 3_000;

let minute = 0;
function item(
  action: string,
  note: string,
  author: "owner" | "agent" = "agent",
): TaskBriefHistoryItem {
  minute += 1;
  return {
    action,
    note,
    authoredBy: author === "owner" ? "Tommaso" : "Claude Code",
    untrusted: author === "agent",
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString(),
  };
}

const filler = (marker: string, length: number) =>
  `${marker} ${"x".repeat(length - marker.length - 1)}`;

const lines = (section: string) =>
  section.split("\n").filter((line) => line.startsWith("- "));

test("routine reports never push the owner's request for changes out of the brief", () => {
  const history = [
    ...Array.from({ length: 10 }, (_, index) =>
      item("reported", filler(`[report ${index + 1}]`, 320)),
    ),
    item("reviewed", "Use list B", "owner"),
  ];
  const section = historySection(history);
  assert.match(section, /reviewed by Tommaso: Use list B/);
  assert.match(section, /\[report 10\]/);
  assert.ok(section.length <= HISTORY_MAX_CHARACTERS + 2);
});

test("a long handoff note keeps the later question, answer and review in the brief", () => {
  const history = [
    item("released", filler("[handoff]", 2_900)),
    item("asked", "[question] Which list should the export use?"),
    item("answered", "[answer] List B, the one shared on 12/10.", "owner"),
    ...Array.from({ length: 8 }, (_, index) =>
      item("reported", filler(`[report ${index + 1}]`, 600)),
    ),
    item("reviewed", "[review] The export still uses list A.", "owner"),
  ];
  const section = historySection(history);
  assert.match(section, /released by Claude Code \(agent\): \[handoff\] x+…/);
  assert.match(section, /asked by Claude Code \(agent\): \[question\]/);
  assert.match(section, /answered by Tommaso: \[answer\] List B/);
  assert.match(section, /reviewed by Tommaso: \[review\]/);
  assert.match(section, /\[report 8\]/);
  assert.ok(section.length <= HISTORY_MAX_CHARACTERS + 2);
  for (const line of lines(section))
    assert.ok(line.length <= 560, `line too long: ${line.length}`);
});

test("a note that does not fit is skipped, not the end of the history", () => {
  const history = [
    ...Array.from({ length: 6 }, (_, index) =>
      item("reported", `[short ${index + 1}] done`),
    ),
    ...Array.from({ length: 6 }, (_, index) =>
      item("reported", filler(`[long ${index + 1}]`, 600)),
    ),
  ];
  const section = historySection(history);
  assert.match(section, /\[long 6\]/);
  assert.match(section, /\[long 2\]/);
  assert.doesNotMatch(section, /\[long 1\]/);
  assert.match(section, /\[short 6\]/);
  assert.ok(section.length <= HISTORY_MAX_CHARACTERS + 2);
});

test("history keeps the newest twelve notes and shows them oldest first", () => {
  const history = Array.from({ length: 20 }, (_, index) =>
    item("reported", `[note ${String(index + 1).padStart(2, "0")}]`),
  );
  const kept = lines(historySection(history));
  assert.equal(kept.length, 12);
  assert.deepEqual(
    kept.map((line) => line.match(/\[note (\d+)\]/)?.[1]),
    Array.from({ length: 12 }, (_, index) =>
      String(index + 9).padStart(2, "0"),
    ),
  );
});

test("an empty history adds no section", () => {
  assert.equal(historySection([]), "");
});
