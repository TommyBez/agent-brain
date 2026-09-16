import { z } from "zod";
import { LINK_TYPES, PAGE_TYPES } from "./types";

// Changing dimensions requires a matching migration and re-embedding the corpus.
export const EMBEDDING_DIMENSIONS = 1536;
export const embeddingSchema = z
  .array(z.number().finite())
  .length(EMBEDDING_DIMENSIONS)
  .refine(
    (values) => values.some((value) => value !== 0),
    "Embedding cannot be a zero vector",
  );
const ref = z.string().trim().min(1).max(220);
const embeddingFields = {
  embedding: embeddingSchema.optional(),
  embeddingModel: z.string().trim().min(1).max(100).optional(),
};
const provenance = {
  reason: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .default("Updated through the brain API"),
  source: z.string().trim().min(1).max(1000).default("agent"),
};

export const readSchema = z.object({ ref }).strict();
export const linkSchema = z
  .object({
    targetRef: ref,
    type: z.enum(LINK_TYPES),
    label: z.string().trim().max(300).default(""),
  })
  .strict();
export const writeSchema = z
  .object({
    id: z.uuid().optional(),
    expectedVersion: z.number().int().min(0),
    slug: z
      .string()
      .trim()
      .regex(
        /^[a-z0-9]+(?:[/-][a-z0-9]+)*$/,
        "Use lowercase letters, numbers, hyphens and path segments",
      )
      .max(200)
      .optional(),
    title: z.string().trim().min(1).max(200),
    type: z.enum(PAGE_TYPES),
    markdown: z.string().min(1).max(200_000),
    summary: z.string().trim().max(2000).default(""),
    aliases: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
    tags: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
    links: z.array(linkSchema).max(100).default([]),
    ...provenance,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.expectedVersion > 0 !== Boolean(input.id)) {
      context.addIssue({
        code: "custom",
        path: ["expectedVersion"],
        message:
          "Use expectedVersion 0 without id to create, or an id and the current positive version to update",
      });
    }
  });

export const appendSchema = z
  .object({
    ref,
    expectedVersion: z.number().int().positive(),
    markdown: z.string().trim().min(1).max(100_000),
    ...provenance,
  })
  .strict();
export const resolveSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    type: z.enum(PAGE_TYPES).optional(),
    limit: z.number().int().min(1).max(20).default(8),
  })
  .strict();
export const searchSchema = z
  .object({
    query: z.string().trim().min(1).max(1000),
    type: z.enum(PAGE_TYPES).optional(),
    limit: z.number().int().min(1).max(50).default(12),
    expandGraph: z.boolean().default(true),
    ...embeddingFields,
  })
  .strict();
export const relatedSchema = z
  .object({
    ref,
    depth: z.number().int().min(1).max(3).default(1),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();
export const contextSchema = z
  .object({
    query: z.string().trim().min(1).max(1000),
    refs: z.array(ref).max(10).default([]),
    limit: z.number().int().min(1).max(20).default(8),
    maxCharacters: z.number().int().min(1000).max(100_000).default(24_000),
    ...embeddingFields,
  })
  .strict();
export const listPagesSchema = z
  .object({
    query: z.string().trim().max(1000).optional(),
    type: z.enum(PAGE_TYPES).optional(),
    sort: z.enum(["updated", "title"]).default("updated"),
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
export const graphSchema = z
  .object({
    limit: z.number().int().min(1).max(500).default(150),
    offset: z.number().int().min(0).default(0),
    type: z.enum(PAGE_TYPES).optional(),
  })
  .strict();
export const revisionsSchema = z
  .object({
    ref,
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
export const revisionSchema = z
  .object({ ref, version: z.number().int().positive() })
  .strict();
export const activitySchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(30),
    offset: z.number().int().min(0).default(0),
  })
  .strict();
export const indexChunksSchema = z
  .object({
    ref,
    expectedVersion: z.number().int().positive(),
    embeddingModel: z.string().trim().min(1).max(100),
    chunkerVersion: z.string().trim().min(1).max(100),
    embeddings: z
      .array(
        z
          .object({
            contentHash: z.string().regex(/^[a-f0-9]{64}$/),
            embedding: embeddingSchema,
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
