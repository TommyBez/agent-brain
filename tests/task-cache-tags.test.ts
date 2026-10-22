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
  "tasksEnabledForOwner",
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

test("the task manager switch is cached under the tasks tag that turning it on or off expires", () => {
  assert.match(
    source,
    /async function tasksEnabledForOwner\(ownerId: string\) \{\s*"use cache";\s*tasksOnly\(ownerId\);\s*return tasksEnabledFor\(ownerId\);/,
  );
  assert.match(
    source,
    /export const getTasksEnabled = cache\(async \(\) => \{\s*const user = await getWorkspaceUser\(\);\s*return tasksEnabledForOwner\(user\.id\);/,
  );
  const actions = readFileSync(
    new URL("../lib/workspace/settings-actions.ts", import.meta.url),
    "utf8",
  );
  const action = actions.match(
    /export async function setTasksEnabledAction\([\s\S]*?\n\}/,
  )?.[0];
  assert.ok(action, "setTasksEnabledAction was found");
  assert.match(action, /updateTasksCache\(user\.id\)/);
});
