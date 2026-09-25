import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig } from "@next/env";
import { Pool } from "pg";
import type { BrainPage } from "../lib/brain/types";

/** One read-only transaction; no service mutation or migration is reachable. */
export async function captureSnapshot(output: string) {
  loadEnvConfig(process.cwd());
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const owners = await client.query<{ ownerId: string }>(
      'SELECT DISTINCT owner_id AS "ownerId" FROM brain_pages',
    );
    if (owners.rows.length !== 1)
      throw new Error("Expected exactly one corpus owner.");
    const ownerId = owners.rows[0].ownerId;
    const { rows } = await client.query(
      `SELECT id, slug, title, type, summary, markdown, aliases, tags, version,
       created_at AS "createdAt", updated_at AS "updatedAt"
       FROM brain_pages WHERE owner_id=$1 ORDER BY slug`,
      [ownerId],
    );
    const { rows: links } = await client.query(
      `SELECT l.id, l.source_id AS "sourceId", l.target_id AS "targetId", l.type, l.label,
       p.title AS "sourceTitle", p.slug AS "sourceSlug", t.title AS "targetTitle", t.slug AS "targetSlug"
       FROM brain_links l JOIN brain_pages p ON p.id=l.source_id AND p.owner_id=l.owner_id
       JOIN brain_pages t ON t.id=l.target_id AND t.owner_id=l.owner_id
       WHERE l.owner_id=$1 ORDER BY l.source_id,l.target_id,l.type`,
      [ownerId],
    );
    const pages: BrainPage[] = rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      embeddedAt: null,
      links: links.filter((link) => link.sourceId === row.id),
      backlinks: links.filter((link) => link.targetId === row.id),
    }));
    await client.query("COMMIT");
    const snapshotHash = createHash("sha256")
      .update(JSON.stringify(pages))
      .digest("hex");
    await mkdir(dirname(output), { recursive: true });
    await writeFile(
      output,
      `${JSON.stringify(
        { capturedAt: new Date().toISOString(), snapshotHash, pages },
        null,
        2,
      )}\n`,
      { flag: "wx", mode: 0o600 },
    );
    return {
      output,
      snapshotHash,
      pages: pages.length,
      links: links.length,
      characters: JSON.stringify(pages).length,
    };
  } finally {
    client.release();
    await pool.end();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const output = process.argv[2];
  if (!output) throw new Error("Supply a new private output path.");
  captureSnapshot(resolve(output))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error: unknown) => {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "unknown";
      console.error(
        `Read-only capture failed (code=${code}); no database write attempted.`,
      );
      process.exitCode = 1;
    });
}
