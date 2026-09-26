import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { writeConsolidationPages } from "../../brain/service";
import { BrainError, LINK_TYPES } from "../../brain/types";
import { assertOwner } from "../../brain/utils";
import { getPool, transaction } from "../../db";
import type { ApplyResult, ChangeSet } from "./types";

export { readConsolidationPages } from "../../brain/service";

const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim().length > 0);
const versionRef = z.object({
  pageId: z.uuid(),
  version: z.number().int().positive(),
});
const edgeSchema = z.object({
  sourceId: z.uuid(),
  targetId: z.uuid(),
  type: z.enum(LINK_TYPES),
  label: z.string().max(300),
});

function serialized(record: unknown): string {
  const encoded = JSON.stringify(record);
  if (encoded === undefined)
    throw new BrainError(
      "INVALID_RECORD",
      "A consolidation record must be JSON serializable.",
    );
  return encoded;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}

function fingerprint(record: unknown): string {
  return createHash("sha256")
    .update(serialized(canonical(record)))
    .digest("hex");
}

function invalid(message: string): never {
  throw new BrainError("INVALID_CHANGE_SET", message);
}

function validateChangeSet(changeSet: ChangeSet) {
  const { changes, plan, draft } = changeSet;
  if (!changes.length || draft.noChange)
    invalid("Only an effective, materialized change set can be applied.");
  const readSet = z.array(versionRef).min(1).parse(plan.readSet);
  const versions = new Map(
    readSet.map(({ pageId, version }) => [pageId, version]),
  );
  if (versions.size !== readSet.length)
    invalid("The read set must contain each page exactly once.");
  const targets = new Set(plan.targetPageIds);
  if (targets.size !== plan.targetPageIds.length)
    invalid("Target pages must be unique.");
  const changed = new Set<string>();
  const addedEdges: unknown[] = [];
  for (const { before, after } of changes) {
    if (changed.has(before.id) || !targets.has(before.id))
      invalid("Every changed page must be a unique plan target.");
    changed.add(before.id);
    if (versions.get(before.id) !== before.version)
      invalid(
        "Every changed page must have its original version in the read set.",
      );
    const immutable = (page: typeof before) => {
      const {
        markdown: _markdown,
        summary: _summary,
        links: _links,
        backlinks: _backlinks,
        ...metadata
      } = page;
      return metadata;
    };
    if (!isDeepStrictEqual(immutable(before), immutable(after)))
      invalid("Consolidation cannot modify unrelated page metadata.");
    z.string().min(1).max(200_000).parse(after.markdown);
    z.string().max(2000).parse(after.summary);
    if (after.links.length > 100)
      invalid("The resulting page exceeds the supported link limit.");
    const remaining = new Map(
      before.links.map((edge) => [
        `${edge.targetId}:${edge.type}`,
        edgeSchema.parse(edge),
      ]),
    );
    const seen = new Set<string>();
    for (const candidate of after.links) {
      const edge = edgeSchema.parse(candidate);
      const key = `${edge.targetId}:${edge.type}`;
      if (
        edge.sourceId !== before.id ||
        edge.targetId === before.id ||
        seen.has(key)
      )
        invalid("Invalid or duplicate resulting link.");
      seen.add(key);
      const existing = remaining.get(key);
      if (existing) {
        if (!isDeepStrictEqual(existing, edge))
          invalid(
            "An existing relationship cannot be changed by an additive link operation.",
          );
        remaining.delete(key);
      } else {
        if (!versions.has(edge.targetId))
          invalid("Every added-link target must be versioned in the read set.");
        addedEdges.push(edge);
      }
    }
    if (remaining.size)
      invalid("Consolidation cannot remove existing relationships.");
    if (
      before.markdown === after.markdown &&
      before.summary === after.summary &&
      before.links.length === after.links.length
    )
      invalid("Unchanged pages must not be submitted for writing.");
  }
  for (const target of targets)
    if (!versions.has(target))
      invalid("Every plan target must be present in the read set.");
  const sortedEdges = (edges: unknown[]) =>
    edges.map((edge) => serialized(canonical(edge))).sort();
  if (
    !isDeepStrictEqual(
      sortedEdges(addedEdges),
      sortedEdges(draft.links.map((edge) => edgeSchema.parse(edge))),
    )
  )
    invalid("The resulting links must match the structured draft exactly.");
}

/** Immutable, content-bound audit records kept outside the knowledge corpus. */
export async function saveConsolidationRecord(
  ownerId: string,
  runId: string,
  key: string,
  record: unknown,
): Promise<void> {
  assertOwner(ownerId);
  identifier.parse(runId);
  identifier.parse(key);
  const value = serialized(record);
  const result = await getPool().query(
    `INSERT INTO brain_consolidation_records (owner_id,run_id,kind,record_key,payload)
     VALUES ($1,$2,'record',$3,$4::jsonb)
     ON CONFLICT (owner_id,run_id,kind,record_key) DO UPDATE SET payload=brain_consolidation_records.payload
     WHERE brain_consolidation_records.payload=EXCLUDED.payload RETURNING record_key`,
    [ownerId, runId, key, value],
  );
  if (!result.rowCount)
    throw new BrainError(
      "RECORD_CONFLICT",
      "A consolidation record key cannot be reused with different content.",
      409,
    );
}

export async function readConsolidationRecord<T = unknown>(
  ownerId: string,
  runId: string,
  key: string,
): Promise<T | null> {
  assertOwner(ownerId);
  identifier.parse(runId);
  identifier.parse(key);
  const result = await getPool().query<{ payload: T }>(
    "SELECT payload FROM brain_consolidation_records WHERE owner_id=$1 AND run_id=$2 AND kind='record' AND record_key=$3",
    [ownerId, runId, key],
  );
  return result.rows[0]?.payload ?? null;
}

export async function beginConsolidationRun(
  ownerId: string,
  runId: string,
): Promise<void> {
  await saveConsolidationRecord(ownerId, runId, "run", { status: "started" });
}

/** Reuse is safe only when the caller's key binds all input and policy versions. */
export async function findConsolidationRecord<T = unknown>(
  ownerId: string,
  key: string,
): Promise<T | null> {
  assertOwner(ownerId);
  identifier.parse(key);
  const result = await getPool().query<{ payload: T }>(
    `SELECT payload FROM brain_consolidation_records WHERE owner_id=$1 AND kind='record' AND record_key=$2
     ORDER BY created_at DESC,run_id DESC LIMIT 1`,
    [ownerId, key],
  );
  return result.rows[0]?.payload ?? null;
}

/** One owner-scoped read for scan/planning caches; heavy audit fields can stay in storage. */
export async function findConsolidationRecords<T = unknown>(
  ownerId: string,
  keys: string[],
  omittedFields: string[] = [],
): Promise<Map<string, T>> {
  assertOwner(ownerId);
  if (!keys.length) return new Map();
  for (const key of keys) identifier.parse(key);
  const result = await getPool().query<{ record_key: string; payload: T }>(
    `SELECT DISTINCT ON (record_key) record_key,payload-$3::text[] AS payload
     FROM brain_consolidation_records WHERE owner_id=$1 AND kind='record' AND record_key=ANY($2::text[])
     ORDER BY record_key,created_at DESC,run_id DESC`,
    [ownerId, [...new Set(keys)], omittedFields],
  );
  return new Map(result.rows.map((row) => [row.record_key, row.payload]));
}

export async function finishConsolidationRun(
  ownerId: string,
  runId: string,
  summary: unknown,
): Promise<void> {
  await saveConsolidationRecord(ownerId, runId, "summary", summary);
}

export async function applyConsolidationChangeSet(
  ownerId: string,
  changeSet: ChangeSet,
  operationKey: string,
): Promise<ApplyResult> {
  assertOwner(ownerId);
  identifier.parse(operationKey);
  validateChangeSet(changeSet);
  const contentHash = fingerprint(changeSet);
  return transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      ownerId,
      `consolidation:${operationKey}`,
    ]);
    const receipt = await db.query<{
      payload: {
        fingerprint: string;
        result: Extract<ApplyResult, { pages: unknown }>;
      };
    }>(
      "SELECT payload FROM brain_consolidation_records WHERE owner_id=$1 AND run_id='operations' AND kind='receipt' AND record_key=$2",
      [ownerId, operationKey],
    );
    if (receipt.rows[0]) {
      if (receipt.rows[0].payload.fingerprint !== contentHash)
        throw new BrainError(
          "OPERATION_KEY_CONFLICT",
          "This operation key already committed a different change set.",
          409,
        );
      return {
        status: "replayed",
        pages: receipt.rows[0].payload.result.pages,
      };
    }
    const result = await writeConsolidationPages(
      db,
      ownerId,
      changeSet.changes,
      changeSet.plan.readSet,
      operationKey,
    );
    if (result.status === "conflict") return result;
    await db.query(
      `INSERT INTO brain_consolidation_records (owner_id,run_id,kind,record_key,payload)
       VALUES ($1,'operations','receipt',$2,$3::jsonb)`,
      [ownerId, operationKey, serialized({ fingerprint: contentHash, result })],
    );
    return result;
  });
}
