import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Database } from "../lib/brain/pages";
import { contextLinks } from "../lib/tasks/explicit-links";
import { upsertTaskLinks } from "../lib/tasks/page-links";

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(root, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [join(root, entry.name)]
        : [],
  );
}
test("task and link insert modules have only the explicit entry points", () => {
  const source = [...files("lib"), ...files("app")];
  const containing = (pattern: RegExp) =>
    source.filter((file) => pattern.test(readFileSync(file, "utf8"))).sort();
  assert.deepEqual(containing(/INSERT INTO brain_tasks\b/), [
    "lib/tasks/service.ts",
  ]);
  assert.deepEqual(containing(/INSERT INTO brain_task_links\b/), [
    "lib/tasks/claims.ts",
    "lib/tasks/page-links.ts",
  ]);
  assert.deepEqual(containing(/\bupsertTaskLinks\(/), [
    "lib/tasks/page-links.ts",
    "lib/tasks/service.ts",
    "lib/tasks/suggestions.ts",
  ]);
  assert.deepEqual(containing(/\bcreateTask\(/), [
    "app/(workspace)/actions/tasks.ts",
    "lib/tasks/service.ts",
  ]);
  const mcp = readFileSync("lib/tasks/mcp-tools.ts", "utf8");
  assert.match(mcp, /create_task: createTask/);
  assert.match(
    readFileSync("lib/tasks/service.ts", "utf8"),
    /if \(kind === "system"\)/,
  );
  assert.doesNotMatch(
    readFileSync("lib/tasks/service.ts", "utf8"),
    /keeperCreateTaskSchema|runDerivedLinks|origin: "recurrence"|origin: "extracted"/,
  );
});

for (const origin of ["owner", "agent"] as const) {
  test(`explicit create/update links are active with ${origin} origin; empty input writes zero`, async () => {
    const writes: { page_id: string; status: string; origin: string }[] = [];
    const db = {
      query: async (_sql: string, params: unknown[]) => {
        const inserted = JSON.parse(params[4] as string);
        writes.push(...inserted);
        return {
          rows: inserted.map(
            (row: { page_id: string; role: string; status: string }) => ({
              pageId: row.page_id,
              role: row.role,
              status: row.status,
            }),
          ),
        };
      },
    } as unknown as Database;
    await upsertTaskLinks(
      db,
      "owner",
      "task",
      "actor",
      contextLinks([], origin),
    );
    assert.equal(writes.length, 0);
    const explicit = contextLinks(
      [
        { id: "p1", version: 1 },
        { id: "p2", version: 2 },
      ],
      origin,
    );
    const mentions = contextLinks([{ id: "p3", version: 1 }], origin, true);
    await upsertTaskLinks(db, "owner", "task", "actor", [
      ...explicit,
      ...mentions,
    ]);
    assert.equal(writes.length, 3);
    assert.ok(
      writes.every((row) => row.origin === origin && row.status === "active"),
    );
    assert.deepEqual(
      writes.map((row) => row.page_id),
      ["p1", "p2", "p3"],
    );
  });
}

test("system actors cannot create tasks before any data access", async () => {
  const { createTask } = await import("../lib/tasks/service");
  const actor = {
    ownerId: "owner",
    agent: { kind: "system" },
  } as unknown as import("../lib/tasks/actors").Actor;
  await assert.rejects(createTask(actor, {}), { code: "NOT_ALLOWED" });
});
