import { pathToFileURL } from "node:url";

// Removed synchronous rules/retrieval and nightly task_links wrote rule/consolidator.
// complete_task still writes produced/provenance suggestions; never retract them.
export const COUNT_SQL = `SELECT count(*)::text AS count FROM brain_task_links WHERE status = 'suggested' AND origin IN ('rule', 'consolidator') AND role <> 'produced' AND decided_at IS NULL AND decided_by_agent_id IS NULL`;
export const RETRACT_SQL = `UPDATE brain_task_links SET status = 'retracted', updated_at = now() WHERE status = 'suggested' AND origin IN ('rule', 'consolidator') AND role <> 'produced' AND decided_at IS NULL AND decided_by_agent_id IS NULL RETURNING page_id`;

export interface QueryClient {
  query(sql: string): Promise<{
    rows: { count?: string }[];
    rowCount: number | null;
  }>;
}

/** No human decision is fabricated: the paired decision columns remain null. */
export async function retractSuggestedTaskLinks(
  client: QueryClient,
  apply = false,
): Promise<{ count: number; changed: number }> {
  if (!apply) {
    const result = await client.query(COUNT_SQL);
    return { count: Number(result.rows[0]?.count ?? 0), changed: 0 };
  }
  // UPDATE RETURNING is one atomic statement: no SELECT/update count race.
  const updated = await client.query(RETRACT_SQL);
  const changed = updated.rowCount ?? 0;
  return { count: changed, changed };
}

async function main() {
  const flags = process.argv.slice(2);
  if (flags.some((flag) => flag !== "--apply"))
    throw new Error(
      "Usage: tsx scripts/retract-suggested-task-links.ts [--apply]",
    );
  // Deliberately no dotenv loader. Connection configuration is supplied by the operator.
  const { getPool } = await import("../lib/db");
  const pool = getPool();
  try {
    const apply = flags.includes("--apply");
    const result = await retractSuggestedTaskLinks(pool, apply);
    console.log(
      apply
        ? `Changed ${result.changed} rows.`
        : `Dry-run: would change ${result.count} rows.`,
    );
  } finally {
    await pool.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Data operation failed.",
    );
    process.exitCode = 1;
  });
}
