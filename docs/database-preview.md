# Database previews and migrations

Agent Brain uses the same deployment pattern as SkillsBoard: the Neon/Vercel
integration supplies an isolated database for each preview Git branch. Vercel
applies committed Drizzle migrations during the build, before building Next.js.
GitHub checks the code and removes preview databases when pull requests close.

The Agent Brain Neon/Vercel connection has **Require Active Resource Before
Deploy** enabled and **Create Database Branch For Deployment: Preview** selected.
Production branching is disabled. These settings were saved and read back on
2026-09-16. The GitHub cleanup also requires the repository credentials below;
committing its workflow alone does not grant access to Neon.

Rebuilding PR #9's existing commit created
`preview/codex/remove-legacy-url-redirects` through Vercel and completed
successfully. That branch inherited the native Drizzle baseline. This first
check verified the provider integration independently of the migration/build
script changes; deployments of those changes must also verify the native
Drizzle build step.

| Event | Database | Action |
| --- | --- | --- |
| Push a feature branch | Neon `preview/<git-branch>` | Vercel builds against the injected preview URLs and applies pending migrations |
| Merge to `main` | Neon production branch | The production build applies pending migrations before building the app |
| Close a same-repository PR | Its `preview/<git-branch>` | GitHub deletes that Neon preview branch, whether merged or closed without merging |
| Local development | The database configured locally | Use a separate development branch and run migrations explicitly |

## Vercel and Neon configuration

1. Connect the Agent Brain Vercel project to its Neon database integration.
2. Enable **Require Active Resource Before Deploy**, then select **Preview**
   under **Create Database Branch For Deployment**. The integration uses the
   `preview/<git-branch>` naming convention.
3. Let the integration supply `DATABASE_URL` and `DATABASE_URL_UNPOOLED` for
   previews. Avoid manually scoped preview values that point to production.
4. Keep production variables bound to the production database and development
   variables bound to a separate persistent development branch.
5. Leave Vercel's build-command override unset. Vercel selects the repository's
   `vercel-build` script, which runs `pnpm db:migrate` before `next build`.

The application uses pooled `DATABASE_URL`. Migration commands use direct
`DATABASE_URL_UNPOOLED`. Both URLs within one environment must belong to the
same Neon branch. A preview branch inherits production's applied migration
history, so Drizzle applies only migrations missing from that preview.

Keep `CRON_SECRET`, `BRAIN_EXPORT_GITHUB_TOKEN`, `NEON_BRANCH_ID` and
`NEON_SNAPSHOT_SCHEDULE_VERIFIED_AT` scoped to Production. Preview databases do
not have the production snapshot schedule and must not write the production Git
export. The owner can still test maintenance manually; Git export requires its
own credential and destination before it can succeed outside production.

## Repository configuration

For `.github/workflows/neon-preview-cleanup.yml`, configure:

- Repository variable `NEON_PROJECT_ID`: the Neon project connected to Vercel.
- Repository secret `NEON_API_KEY`: a project-scoped Neon API key authorized to
  delete branches in that project. Create it in Neon organization settings under
  **API keys**, select **Project-scoped**, and choose only Agent Brain. Save the
  key as an Actions secret in `TommyBez/agent-brain`; no additional GitHub App
  installation is needed.

On 2026-09-16, `NEON_PROJECT_ID` was verified as
`crimson-queen-75233553`, and the project-scoped key
`agent-brain-preview-cleanup` was saved as `NEON_API_KEY` and its presence verified
in the repository. Cleanup becomes active once the workflow is merged into
`main`; an actual PR-close cleanup run has not yet been verified.

Cleanup runs on `pull_request_target` close events and only for pull requests
whose head repository matches the current repository. It runs no checkout or PR
code. The official Neon action resolves the exact `preview/<git-branch>` name
and deletes that branch. Fork PRs are skipped.

The workflow validates branch names before invoking the action because its
branch input is interpolated into Bash upstream. Names containing characters
outside letters, digits, dots, underscores, slashes, and hyphens fail cleanup
before the secret is used and require manual branch cleanup.

The CI workflow runs lint, type checking, unit tests, and `pnpm db:check` without
provider credentials. The database check validates Drizzle metadata and generates
against a temporary copy of the snapshots; it fails if the schema needs a
migration that has not been committed. Database and authenticated browser integration tests
remain separately gated; the CI unit-test job does not claim those checks ran.

## Migration workflow

Generate migrations from the schema with `pnpm db:generate --name <description>`,
review the SQL, and commit it together with the schema and generated metadata.
Do not edit Drizzle metadata manually or use schema push on a migration-managed
database. Use `pnpm db:migrate` for the configured local development database.

Build-time migrations run while the previous deployment is still serving
requests. Destructive schema changes require a coordinated release so that
running code never queries columns already removed from the database.

## Verify the setup

For a feature-branch deployment, inspect the Neon branch and Vercel environment
assignment, then confirm the migration step and application build succeeded.
Check that the preview URL serves the expected code against that preview DB.
After closing the PR, inspect the cleanup workflow result and confirm the
matching preview branch was removed while production and development remain.
