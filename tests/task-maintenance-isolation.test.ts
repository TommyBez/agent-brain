import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { POLICY } from "../lib/maintenance/consolidator/types";

const root = resolve(import.meta.dirname, "..");

/** Value imports of a module, resolved to repository files (packages skipped). */
function valueImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const found: string[] = [];
  const pattern =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[4] ?? match[5];
    if (match[2]) continue;
    const names = (match[3]?.match(/^\{([\s\S]*)\}$/)?.[1] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    if (names.length && names.every((name) => name.startsWith("type ")))
      continue;
    const base = specifier.startsWith("@/")
      ? join(root, specifier.slice(2))
      : specifier.startsWith(".")
        ? resolve(dirname(file), specifier)
        : null;
    if (!base) continue;
    const target = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      join(base, "index.ts"),
    ].find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
    );
    if (target) found.push(target);
  }
  return found;
}

function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [resolve(root, entry)];
  while (pending.length) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (/\.tsx?$/.test(file)) pending.push(...valueImports(file));
  }
  return new Set([...seen].map((file) => relative(root, file)));
}

function files(directory: string): string[] {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { recursive: true })
    .map(String)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => join(directory, name));
}

test("the page consolidator policy version is unchanged by the task phases", () => {
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

test("task maintenance reuses the evaluation cache without the steps.ts graph", () => {
  const forbidden = [
    "lib/maintenance/consolidator/steps.ts",
    "lib/maintenance/consolidator/reuse.ts",
    "lib/maintenance/consolidator/verifier.ts",
  ];
  const entries = [
    "lib/maintenance/consolidator/evaluation-cache.ts",
    "lib/maintenance/task-phase-halt.ts",
    ...files("lib/maintenance/task-keeper"),
    ...files("lib/maintenance/task-links"),
  ];
  assert.ok(entries.includes("lib/maintenance/task-keeper/index.ts"));
  assert.ok(entries.includes("lib/maintenance/task-links/index.ts"));
  for (const entry of entries) {
    const graph = reachable(entry);
    for (const file of forbidden)
      assert.equal(graph.has(file), false, `${entry} reaches ${file}`);
  }
  assert.ok(
    reachable("lib/maintenance/consolidator/steps.ts").has(
      "lib/maintenance/consolidator/evaluation-cache.ts",
    ),
  );
});

test("the nightly stage contract stays importable by the Workflow sandbox", () => {
  for (const entry of [
    "lib/maintenance/task-phase.ts",
    "lib/maintenance/nightly-stages.ts",
  ])
    assert.deepEqual([...reachable(entry)], [entry]);
});
