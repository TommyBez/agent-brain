import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Every task row carries its project's title and slug (TASK_VIEW_SELECT), so
// a cached read that returns task rows or page titles must also carry the
// workspace tag: a page rename expires only that tag.

const source = readFileSync(
  new URL("../lib/workspace/tasks-data.ts", import.meta.url),
  "utf8",
);
const TASKS_ONLY = new Set([
  "activityForOwner",
  "formChoicesForOwner",
  "settingsForOwner",
]);

test("cached task views that show project or page fields carry the workspace tag", () => {
  const readers = [
    ...source.matchAll(
      /async function (\w+ForOwner)\([^)]*\)\s*\{\s*"use cache";\s*(tasksOnly|withPages)\(ownerId\);/g,
    ),
  ];
  assert.ok(readers.length >= 15, "every cached reader was found");
  for (const [, name, tagging] of readers)
    assert.equal(
      tagging,
      TASKS_ONLY.has(name) ? "tasksOnly" : "withPages",
      `${name} uses ${tagging}`,
    );
  for (const name of [
    "overviewForOwner",
    "tableForOwner",
    "boardForOwner",
    "calendarForOwner",
    "projectTasksForOwner",
    "personTasksForOwner",
  ])
    assert.ok(
      readers.some(
        ([, reader, tagging]) => reader === name && tagging === "withPages",
      ),
      name,
    );
});
