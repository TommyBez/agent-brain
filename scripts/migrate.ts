import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

async function main() {
  const connectionString =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DIRECT_DATABASE_URL ||
    process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error(
      "Set DATABASE_URL_UNPOOLED to a direct Neon Postgres connection before running migrations.",
    );
  const hostname = new URL(connectionString).hostname;
  if (hostname.includes("-pooler"))
    throw new Error(
      "Migrations require the direct, unpooled connection. Set DATABASE_URL_UNPOOLED.",
    );
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtext('agent-brain:migrations'))",
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS brain_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const directory = path.join(process.cwd(), "migrations");
    const files = (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of files) {
      const sql = await readFile(path.join(directory, name), "utf8");
      const sha = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ sha256: string }>(
        "SELECT sha256 FROM brain_migrations WHERE name = $1",
        [name],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].sha256 !== sha)
          throw new Error(
            `Applied migration changed: ${name}. Add a new migration instead.`,
          );
        console.info(`Already applied: ${name}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO brain_migrations (name, sha256) VALUES ($1, $2)",
          [name, sha],
        );
        await client.query("COMMIT");
        console.info(`Applied: ${name}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query(
      "SELECT pg_advisory_unlock(hashtext('agent-brain:migrations'))",
    );
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Migration failed");
  process.exitCode = 1;
});
