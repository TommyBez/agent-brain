import type { Principal } from "../auth-principal";
import { resolveActor } from "../tasks/actors";
import * as schemas from "./schemas";
import * as service from "./service";

const read = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};
const write = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
  idempotentHint: false,
};

export const TIMESHEET_TOOLS = [
  {
    name: "list_time_entries",
    scope: "brain:read" as const,
    invalidates: "none" as const,
    config: {
      description:
        "List the owner's timesheet by inclusive date range and optional project. projectRef null selects unassigned entries. Returns paginated entries, total count and totalMinutes across ALL matches, plus nextOffset.",
      inputSchema: schemas.listTimeEntriesSchema,
      annotations: read,
    },
    handler: service.listTimeEntries,
  },
  {
    name: "read_time_entry",
    scope: "brain:read" as const,
    invalidates: "none" as const,
    config: {
      description:
        "Read a time entry and its current version before editing or deleting. A non-null deletedAt marks a tombstone.",
      inputSchema: schemas.readTimeEntrySchema,
      annotations: read,
    },
    handler: service.readTimeEntry,
  },
  {
    name: "create_time_entry",
    scope: "brain:write" as const,
    invalidates: "timesheet" as const,
    config: {
      description:
        "Log actual work requested by the owner: date, whole minutes, optional note and optional project. Never estimate unreported time. Generate an idempotencyKey UUID and reuse it for identical retries; replay returns the existing entry, including a tombstone if deleted.",
      inputSchema: schemas.createTimeEntrySchema,
      annotations: { ...write, destructiveHint: false, idempotentHint: true },
    },
    handler: async (ownerId: string, input: unknown, principal: Principal) =>
      service.createTimeEntry(await resolveActor(ownerId, principal), input),
  },
  {
    name: "update_time_entry",
    scope: "brain:write" as const,
    invalidates: "timesheet" as const,
    config: {
      description:
        "Correct a time entry using its current expectedVersion. Omitted patch fields are preserved; projectRef null unassigns the project. On conflict, read again and reconcile.",
      inputSchema: schemas.updateTimeEntrySchema,
      annotations: write,
    },
    handler: async (ownerId: string, input: unknown, principal: Principal) =>
      service.updateTimeEntry(await resolveActor(ownerId, principal), input),
  },
  {
    name: "delete_time_entry",
    scope: "brain:write" as const,
    invalidates: "timesheet" as const,
    config: {
      description:
        "Delete a time entry at the owner's request using its current expectedVersion. Removes it from lists and totals; retains a tombstone to prevent duplicate creation on retries.",
      inputSchema: schemas.deleteTimeEntrySchema,
      annotations: write,
    },
    handler: async (ownerId: string, input: unknown, principal: Principal) =>
      service.deleteTimeEntry(await resolveActor(ownerId, principal), input),
  },
];
