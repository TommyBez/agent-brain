import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { mcpToolInvalidation, requiredMcpScope } from "../lib/mcp/server";
import { TIMESHEET_TOOLS } from "../lib/timesheet/mcp-tools";
import {
  createTimeEntrySchema,
  deleteTimeEntrySchema,
  formatDuration,
  listTimeEntriesSchema,
  updateTimeEntrySchema,
} from "../lib/timesheet/schemas";

test("timesheet validates dates, whole-minute durations and optional projects", () => {
  const input = {
    workedOn: "2024-02-29",
    minutes: 90,
    idempotencyKey: randomUUID(),
  };
  assert.equal(createTimeEntrySchema.parse(input).projectRef, undefined);
  assert.equal(
    createTimeEntrySchema.parse({ ...input, projectRef: null }).projectRef,
    null,
  );
  for (const minutes of [0, -1, 1.5, 1441, Infinity])
    assert.equal(
      createTimeEntrySchema.safeParse({ ...input, minutes }).success,
      false,
    );
  for (const workedOn of ["2026-02-29", "2026-11-31", "2026-11-16T10:00:00Z"])
    assert.equal(
      createTimeEntrySchema.safeParse({ ...input, workedOn }).success,
      false,
    );
  assert.equal(
    createTimeEntrySchema.safeParse({ ...input, projectRef: "" }).success,
    false,
  );
  assert.equal(
    createTimeEntrySchema.safeParse({ ...input, ownerId: "other" }).success,
    false,
  );
  assert.equal(formatDuration(125), "2h 5m");
});

test("timesheet filters distinguish all projects and unassigned, and mutations require a version", () => {
  assert.equal(listTimeEntriesSchema.parse({}).projectRef, undefined);
  assert.equal(
    listTimeEntriesSchema.parse({ projectRef: null }).projectRef,
    null,
  );
  assert.equal(
    listTimeEntriesSchema.safeParse({ from: "2026-11-17", to: "2026-11-16" })
      .success,
    false,
  );
  const id = randomUUID();
  assert.equal(
    updateTimeEntrySchema.safeParse({ id, expectedVersion: 1, patch: {} })
      .success,
    false,
  );
  assert.equal(
    updateTimeEntrySchema.safeParse({
      id,
      expectedVersion: 1,
      patch: { projectRef: null },
    }).success,
    true,
  );
  assert.equal(deleteTimeEntrySchema.safeParse({ id }).success, false);
});

test("timesheet MCP tools enforce scopes and invalidate only timesheet data", () => {
  for (const tool of TIMESHEET_TOOLS) {
    assert.equal(
      requiredMcpScope({ method: "tools/call", params: { name: tool.name } }),
      tool.scope,
    );
    assert.equal(
      mcpToolInvalidation(tool.name),
      tool.scope === "brain:read" ? "none" : "timesheet",
    );
  }
});
