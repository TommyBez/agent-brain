import { z } from "zod";

const fields = {
  workedOn: z.iso
    .date()
    .describe("Local calendar date, YYYY-MM-DD; no timezone conversion."),
  minutes: z
    .number()
    .int()
    .min(1)
    .max(1440)
    .describe("Actual time worked, in whole minutes (1–1440)."),
  note: z.string().trim().max(2000).default(""),
  projectRef: z
    .string()
    .trim()
    .min(1)
    .max(220)
    .nullable()
    .optional()
    .describe(
      "Existing project page id or canonical slug. Omit or use null for no project.",
    ),
};

export const createTimeEntrySchema = z
  .object({
    ...fields,
    idempotencyKey: z
      .uuid()
      .describe(
        "New UUID per intended entry; reuse it with the same input when retrying.",
      ),
  })
  .strict();

export const readTimeEntrySchema = z.object({ id: z.uuid() }).strict();
export const deleteTimeEntrySchema = readTimeEntrySchema.extend({
  expectedVersion: z.number().int().positive(),
});
export const updateTimeEntrySchema = deleteTimeEntrySchema.extend({
  patch: z
    .object({
      workedOn: fields.workedOn.optional(),
      minutes: fields.minutes.optional(),
      note: z.string().trim().max(2000).optional(),
      projectRef: fields.projectRef,
    })
    .strict()
    .refine(
      (patch) => Object.values(patch).some((value) => value !== undefined),
      "Change at least one field",
    ),
});

export const listTimeEntriesSchema = z
  .object({
    from: z.iso.date().optional().describe("Inclusive first date."),
    to: z.iso.date().optional().describe("Inclusive last date."),
    projectRef: fields.projectRef.describe(
      "Omit for all projects; null means only entries without a project.",
    ),
    limit: z.number().int().min(1).max(100).default(30),
    offset: z.number().int().min(0).max(100000).default(0),
  })
  .strict()
  .refine(
    (input) => !input.from || !input.to || input.from <= input.to,
    "The end date must be on or after the start date",
  );

export type TimeEntry = {
  id: string;
  workedOn: string;
  minutes: number;
  note: string;
  projectId: string | null;
  projectTitle: string | null;
  projectSlug: string | null;
  version: number;
  deletedAt: string | null;
};

export function formatDuration(minutes: number) {
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
