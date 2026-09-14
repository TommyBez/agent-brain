import { attachDatabasePool } from "@vercel/functions";
import { Pool, type PoolClient } from "pg";

const globalForPool = globalThis as typeof globalThis & { brainPool?: Pool };

export function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool(): Pool {
  if (!process.env.DATABASE_URL)
    throw new Error(
      "DATABASE_URL is not configured. Connect a Neon Postgres database before using the brain.",
    );
  if (!globalForPool.brainPool) {
    globalForPool.brainPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 10_000,
    });
    if (process.env.VERCEL) attachDatabasePool(globalForPool.brainPool);
  }
  return globalForPool.brainPool;
}

export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
