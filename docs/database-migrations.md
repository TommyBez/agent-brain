# Database migrations

`lib/db/schema.ts` is the schema source of truth. `drizzle.config.ts` loads the
project environment with Next.js's `@next/env` and uses the direct
`DATABASE_URL_UNPOOLED` connection. Existing environment values take precedence
over `.env.local`; CI and deployments do not need an environment file.

The application continues to use its existing `pg` queries. Drizzle owns schema
generation and migration execution, with its standard
`drizzle.__drizzle_migrations` register. There is no application migration runner.

## Changing the schema

1. Edit `lib/db/schema.ts`.
2. Run `pnpm db:generate --name=describe_change`.
3. Review the SQL and include any necessary data transformation before the
   affected constraints or columns change.
4. Run `pnpm db:check`. It checks Drizzle metadata and verifies that generating
   from the schema produces no uncommitted schema changes, without connecting
   to a database.
5. Apply `pnpm db:migrate` on an isolated Neon branch and run the relevant
   integration tests before production deployment.

Commit the schema, SQL and `drizzle/meta` together. Do not edit migrations that
have already been applied. For SQL that cannot be expressed in the schema, use
`pnpm db:generate --custom --name=describe_change` and edit the generated SQL.
Use migrations for deployed databases rather than `drizzle-kit push`.

## New database

Set `DATABASE_URL_UNPOOLED` to its direct connection and run `pnpm db:migrate`.
`0000_baseline.sql` creates the complete original schema, including `vector`,
`pg_trgm`, the generated full-text search document, graph constraints, chunk
indexes and Better Auth/OAuth tables. `0001_remove_retired_storage.sql` then
removes the retired page vectors, GitHub job history, cancelled jobs from either
executor, executor/lease fields and old migration register. The final schema
contains only the current application storage. Running the command again skips
already recorded migrations.

## Existing installation: one-time adoption

Agent Brain's production database was registered at this baseline on 2026-09-16
after an exact catalog comparison. Only the Drizzle register was created;
the application cleanup remains pending until the coordinated release below.
New Neon preview branches inherit this registration. Do not repeat it there.

This procedure applies to the original installation with raw migrations through
`008-retire-github-jobs.sql`, before the retired storage cleanup. Confirm that
the target is at that state and rehearse on a disposable branch first. Take a
database snapshot before changing production. Preserve canonical pages,
revisions, graph links, chunks and authentication records.

Do not run the initial table-creation migration against existing tables. The
baseline was checked against the existing PostgreSQL catalog; after confirming
that the target has that same schema, register it once using the direct
connection:

```sql
BEGIN;
CREATE SCHEMA drizzle;
CREATE TABLE drizzle.__drizzle_migrations (
  id serial PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES (
  'a92aa9477c430d978c3971054c25142f8717cf2da8749d1f8cf62758c45ba8d5',
  1789544966255
);
COMMIT;
```

These values are the SHA256 of the complete `drizzle/0000_baseline.sql` file and
its `when` value in `drizzle/meta/_journal.json`. Verify them before adoption:

```sh
shasum -a 256 drizzle/0000_baseline.sql
cat drizzle/meta/_journal.json
```

Then run `pnpm db:migrate`. Drizzle skips the baseline and applies only the
cleanup. This deletes the retired GitHub runner's job history and cancelled jobs
from either executor before tightening the status constraint. Other Workflow jobs
remain unchanged, and the old `brain_migrations` table is removed. Run the command
a second time and verify that the register still contains exactly the two
migration records:

```sql
SELECT id, hash, created_at
FROM drizzle.__drizzle_migrations
ORDER BY created_at;
```

The registration is a deployment transition, not a startup hook or a fallback
inside the migrator. Do not run it on new databases or repeat it after adoption.
Drizzle Kit 0.31.10 does not support `pull --init`; this repository uses the stable
CLI and its standard migration register.

## Releasing the cleanup

`vercel-build` runs `pnpm db:migrate && next build`, as in SkillsBoard. Registering
the baseline on an existing installation creates only Drizzle's register; it
does not remove any application columns or records. Complete that registration
before allowing the first build that uses native migrations.

The cleanup itself is destructive. Earlier application deployments still query
the removed fields, so coordinate the production cutover before deploying this
change: stop requests and maintenance against the old deployment while the
database and application are updated together. Resume them only after the new
deployment has passed its smoke checks. There is no runtime compatibility path.
See [database previews](database-preview.md) for the regular deployment setup.

## Verification performed for adoption

The baseline was applied to an empty database on a disposable Neon branch. Its
catalog matched the original installation's 235 columns, 213 constraints, 69
indexes and three installed extensions. The cleanup was then applied both there
and to a production clone using the one-time registration above. Schema
equivalence, retained data hashes and a repeated migration run are checked
separately from application tests.
