import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { brainPages } from "./brain";
import { brainAgents } from "./tasks";

export const brainTimeEntries = pgTable(
  "brain_time_entries",
  {
    id: uuid().defaultRandom().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workedOn: date("worked_on", { mode: "string" }).notNull(),
    minutes: integer().notNull(),
    note: text().notNull().default(""),
    projectId: uuid("project_id"),
    version: integer().notNull().default(1),
    idempotencyKey: uuid("idempotency_key").notNull(),
    inputHash: text("input_hash").notNull(),
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    unique("brain_time_entries_owner_key").on(
      table.ownerId,
      table.idempotencyKey,
    ),
    foreignKey({
      // Page types may change; validate the type when assigning a new project.
      columns: [table.ownerId, table.projectId],
      foreignColumns: [brainPages.ownerId, brainPages.id],
      name: "brain_time_entries_project_fk",
    }),
    foreignKey({
      columns: [table.ownerId, table.createdBy],
      foreignColumns: [brainAgents.ownerId, brainAgents.id],
      name: "brain_time_entries_creator_fk",
    }),
    foreignKey({
      columns: [table.ownerId, table.updatedBy],
      foreignColumns: [brainAgents.ownerId, brainAgents.id],
      name: "brain_time_entries_editor_fk",
    }),
    index("brain_time_entries_owner_date_idx")
      .on(table.ownerId, table.workedOn, table.id)
      .where(sql`deleted_at IS NULL`),
    index("brain_time_entries_owner_project_idx")
      .on(table.ownerId, table.projectId, table.workedOn)
      .where(sql`deleted_at IS NULL`),
    check("brain_time_entries_minutes_check", sql`minutes BETWEEN 1 AND 1440`),
    check("brain_time_entries_note_check", sql`char_length(note) <= 2000`),
    check("brain_time_entries_version_check", sql`version > 0`),
  ],
);
