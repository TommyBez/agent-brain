import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/** Keep check expressions identical to the committed PostgreSQL schema. */
export function oneOf(column: AnyPgColumn, values: readonly string[]) {
  const choices = values.map((value) =>
    sql.raw(`'${value.replaceAll("'", "''")}'::text`),
  );
  return sql`${sql.raw(column.name)} = ANY (ARRAY[${sql.join(choices, sql.raw(", "))}])`;
}

/** Array column whose elements all belong to `values`; empty arrays pass. */
export function subsetOf(column: AnyPgColumn, values: readonly string[]) {
  const choices = values.map((value) =>
    sql.raw(`'${value.replaceAll("'", "''")}'::text`),
  );
  return sql`${sql.raw(column.name)} <@ ARRAY[${sql.join(choices, sql.raw(", "))}]`;
}
