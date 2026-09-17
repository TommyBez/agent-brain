# a native brain

A private, agent-native second brain. The “a” also stands for “agent”. One canonical Markdown page per person, client, project, article, decision or note, connected by typed links. Postgres is the source of truth. Conversations happen in your agent; this application stores, validates, organizes and retrieves knowledge.

The MCP request path exposes validated storage and retrieval primitives, with automatic query embeddings. Vercel Cron starts a durable Vercel Workflow for consolidation, page embeddings and Git export. Remote MCP is the primary interface. The browser provides a knowledge desk for reading, editing, graph navigation, revisions, credentials and operational status.

Using a native brain from an agent? [Connect through MCP](#connect-an-agent) and install the [a native brain skill](#agent-skill).

## Local setup

Requires Node.js 24, pnpm 11, and Postgres with `vector` and `pg_trgm` (Neon).

```sh
pnpm install
cp .env.example .env.local
# Fill database URLs, auth secret, origin and owner email.
pnpm db:migrate
pnpm owner:bootstrap
pnpm dev
```

Bootstrap prompts for a hidden password and creates exactly one owner. Public signup is disabled. It refuses to reset an existing owner. Change the password from the authenticated settings screen.

```sh
pnpm typecheck
pnpm lint
pnpm test
# Integration tests: use a dedicated Neon test branch, never production.
RUN_DB_TESTS=1 node --env-file=.env.test --import tsx --test tests/*.integration.test.ts
pnpm build
```

Integration tests use isolated owner IDs and remove only their own fixtures. Database changes use native Drizzle Kit migrations and the direct `DATABASE_URL_UNPOOLED` connection. Edit `lib/db/schema.ts`, run `pnpm db:generate`, review the SQL, and run `pnpm db:check` before applying it with `pnpm db:migrate`. See [database migrations](docs/database-migrations.md) for the one-time adoption procedure on an existing installation.

## Next.js application

The browser workspace uses App Router routes: `/` for the searchable library, `/graph`, `/activity`, `/agents`, `/operations`, and `/pages/[id]` with separate edit and history routes. Filters, ordering and pagination live in the URL. Links use Next.js navigation and partial prefetching. The graph page loads the most recently updated pages in bounded sets, lays them out with a deterministic force simulation (`lib/graph/layout.ts`, no rendering dependency), and offers zoom, pan, drag, search, type and relationship filters, and an inspector for walking connections; `?node=<id>` preselects a loaded page.

Cache Components and Partial Prefetching are enabled. Shared navigation and route shells render immediately; explicit, local Suspense boundaries stream authenticated statistics, lists, page content, relationships and live status. There are no route-level `loading.tsx` files. Server Components call the data layer directly instead of fetching the application's own HTTP APIs. The client handles input, form state, graph interaction and other browser behavior.

The server data layer rechecks the owner session before reading owner-keyed caches. Knowledge caches use explicit 30-second client freshness, 30-second background revalidation and 60-second expiry. Server Actions invalidate the owner tag with `updateTag` after a committed save. HTTP/MCP writes and Workflow steps expire the same tag immediately. Navigation follows the client cache freshness window; Back/Forward can restore an existing view. Refresh requests current server state. External agent writes are not pushed into already open tabs. Sessions, token metadata and live operations are not persisted in these caches.

See [the rendering and verification guide](docs/next-app-router.md) for route boundaries, invalidation, navigation checks, and the gated HTTP acceptance command (`RUN_NEXT_TESTS=1` with isolated `BRAIN_TEST_*` fixture settings).

## UI components

Use the vendored shadcn components in `components/ui` unchanged, through their standard variants, sizes and composition APIs. Theme them through the tokens in `app/globals.css`; do not override their borders, padding, focus rings, disabled states or interaction behavior. Adapt registry import paths to the configured project aliases when installing a component.

Application code must use semantic color tokens, never literal colors or Tailwind palette utilities. Entity variants define local tokens in the theme. Unmodified shadcn components also consume Tailwind's built-in palette tokens, mapped centrally where needed. `tests/ui-tokens.test.ts` checks this boundary.

Use standard Tailwind spacing, typography and responsive layout utilities. Custom CSS is limited to rendered Markdown typography and accessibility preferences. Graph geometry is application-specific; graph colors still use theme tokens. The Item registry component keeps its original list markup; its one semantic-element lint preference is configured in Biome rather than patched in vendored source.

## Connect an agent

Connect to `https://YOUR_DOMAIN/mcp` using Streamable HTTP and **OAuth 2.1**. Add the URL in your agent, choose OAuth if prompted, sign in to a native brain, and approve the requested permissions. The agent discovers the authorization server and obtains its own access token using authorization code + PKCE. No manually generated token or client secret is needed for interactive clients.

For clients that use this configuration format:

```json
{
  "mcpServers": {
    "brain": {
      "type": "http",
      "url": "https://YOUR_DOMAIN/mcp"
    }
  }
}
```

Configuration formats differ between agents. Use the canonical URL shown in **Agents & access**, which matches the OAuth resource audience. Better Auth's MCP and CIMD plugins support HTTPS client metadata documents; dynamic registration supports clients without CIMD. Access tokens last 15 minutes. Clients requesting `offline_access` can refresh their connection. MCP SDK v2 provides stateless transport and compatibility with earlier protocol clients.

For browser-hosted clients, explicitly add their origin to `MCP_ALLOWED_ORIGINS` (comma-separated). Native and server-hosted cloud clients do not need this setting.

External headless agents have a separate optional token path: create a scoped token in **Agents & access → Headless agent tokens**, and send `Authorization: Bearer YOUR_AGENT_TOKEN` with MCP requests. These tokens are shown once, stored only as hashes, expiring and revocable. Built-in nightly maintenance runs inside the application and does not require a headless agent token.

| Primitive | Behavior |
| --- | --- |
| `resolve` | Canonical names/aliases and fuzzy candidates; Postgres enforces identity uniqueness. |
| `read` | Full page, version, links and backlinks in a consistent snapshot. |
| `write` | Atomic replacement of page, aliases and outgoing links; current ID and expectedVersion required. Create with version 0. |
| `append` | Version-checked append with provenance; invalidates obsolete embeddings. |
| `search` | Automatic query embeddings + weighted full text, reciprocal-rank fusion and graph expansion. |
| `related` | Bounded traversal of typed edges. |
| `context` | Sized Markdown evidence bundle with references, versions, links, gaps and retrieval mode. |

Maintenance tools expose paginated pages, gaps and pending chunk embeddings. `pending_embeddings` with `chunkLimit` returns a bounded batch of missing inputs; `index_chunks` accepts version-checked batches and publishes the index only when the full page is covered. Procedures are MCP instructions, resource `brain://procedures`, and prompts `before_work`, `after_conversation`, `nightly_consolidation`. The canonical procedure text lives in `lib/mcp/server.ts`; the portable skill refers to these prompts.

All tools scope data to the authenticated owner. Foreign keys prevent cross-owner links. Accepted writes create full revisions and audit entries. On conflict, reread and reconcile. `write` replaces aliases, tags and outgoing links, so callers must preserve existing values deliberately.

## Agent skill

The portable [`brain-memory` skill](skills/brain-memory/SKILL.md) guides agents using a native brain: retrieve context, resolve identities, preserve durable knowledge and verify saves. Its [writing reference](skills/brain-memory/references/writing-pages.md) explains full replacements, link payloads and conflict handling. The live MCP instructions, prompts and tool schemas remain authoritative; clients that expose only tools can follow the skill's workflow directly.

Install it in a project using the [Skills CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add TommyBez/agent-brain --skill brain-memory
```

From a local checkout, use `npx skills add ./skills/brain-memory`. Alternatively, copy the complete `skills/brain-memory` folder into your client's supported skill directory. Repository access is required if the repository is private. Installing the skill does not connect or authorize MCP; complete [the connection steps](#connect-an-agent) separately.

Example requests after connecting:

- “Use a native brain to recover the context and open decisions for this project.”
- “Save the decisions from this conversation in a native brain, preserving their rationale and sources.”
- “Review possible duplicates in a native brain and show me the uncertain cases.”

In clients supporting explicit skill invocation, use `$brain-memory`. No database credentials, Git export access or model provider key is needed for ordinary agent use.

## Retrieval

Agents call `search` and `context` with plain text. The server generates the query embedding through AI Gateway using `openai/text-embedding-3-small` with 1536 dimensions, matching the section embeddings generated by the nightly workflow. Advanced clients can still supply their own matching query vectors, which bypass the provider call. The server validates dimensions, model and page version.

Set the server-only `BRAIN_EMBEDDING_API_KEY` to a dedicated AI Gateway key. Identical queries share a bounded, owner/model-scoped in-process cache for 15 minutes; concurrent identical requests share one provider call. A 3.5-second provider timeout, missing configuration or invalid provider output falls back to text and graph. Search returns `{ results, retrieval }` consistently through the core service, MCP and consolidation tools. Its `retrieval` field and `context.retrieval` report the effective mode, model and embedding source. Set `BRAIN_QUERY_EMBEDDINGS=false` to explicitly disable server inference. The browser library filter remains text-based.

Postgres indexes include weighted language-neutral full text, trigram names, HNSW cosine vectors and graph edges. Every Markdown page is indexed in overlapping, paragraph-oriented sections of at most 1,200 `cl100k_base` tokens, including title/summary context. Oversized metadata is indexed separately. Unicode boundaries are preserved and the entire Markdown is covered, including the end of long pages. These sections are derived search data: each entity still has exactly one canonical page.

Each workflow step requests at most 24 missing section inputs and submits vectors in a bounded batch. Matching content hashes reuse vectors from earlier revisions of the same page and model. Batches survive interruption, while version checks prevent an obsolete step from publishing its result. A page becomes fully indexed only after all its sections have embeddings; obsolete revisions are excluded from semantic retrieval.

Semantic results are grouped by page and include the best matching passage; `context` prioritizes that passage so a small context budget can still contain evidence from deep in a long page. Context budgets count characters, and `read` returns the complete Markdown. Writes become searchable by text immediately; vector freshness follows the nightly workflow. Each indexing run is bounded to 100 completed pages and 120,000 input tokens; unfinished sections remain pending for the next night, without truncation. Changing dimensions requires a migration and re-index.

## Nightly maintenance, export and backup

**One schedule runs maintenance: Vercel Cron at 02:00 UTC.** The authenticated `/api/cron/nightly` route starts a durable Vercel Workflow. The route returns promptly; model requests, tool calls, embedding batches and Git export run as separate resumable steps. Postgres records daily jobs and results; a workspace lock prevents overlapping maintenance, and repeated requests reuse the day's work.

1. **Consolidation:** DeepSeek `deepseek/deepseek-v4.1-flash` through AI Gateway reviews changed-page summaries and gap analysis. It reads pages, resolves identities and makes evidence-backed, version-checked improvements through the same validated brain primitives used by MCP. Page content is treated as evidence, never as instructions. Limits are 16 model rounds, eight successful writes, 120,000 input tokens and 18,000 output tokens. The final narrative report and counters are stored with the job. Persisted tool receipts prevent a retried step from repeating an accepted write.
2. **Section embeddings:** after consolidation finishes, including failure, the workflow indexes missing sections in batches of at most 24 chunks. Unchanged content reuses vectors; complete-page coverage and version checks remain mandatory. Accepted batches persist independently. A run that reaches its budget is recorded as `partial`, and pending work continues the next night.
3. **Git export:** independently of the embedding result, the workflow exports a consistent database snapshot as Markdown pages, `graph.json` and a manifest to the private export repository. GitHub's API creates a daily commit and updates the branch without force. Receipts for each export attempt and remote readback make retries safe. A job succeeds only after its commit is reachable from the remote branch. Export makes no AI calls.

Vercel Workflow retries transient step failures. Completed and partial jobs are reused for the same UTC date. If a retried consolidation changes pages after indexing or export already finished, those stages run again to include the changes. Each export attempt has a stable receipt, so replaying a step cannot publish duplicate commits. **Operations → Run maintenance** starts today's work or retries failed jobs through a Server Action; the page shows results, consolidation reports, export commits and errors. GitHub holds the exported files and history; it runs no scheduled maintenance.

Configure `AI_GATEWAY_API_KEY` on Vercel for consolidation and section embeddings, and retain the separate `BRAIN_EMBEDDING_API_KEY` for interactive query embeddings. The maintenance key has a $5/month cap and the query key a $1/month cap, without automatic top-up. These are provider-side budgets. Model requests use the AI Gateway REST API.

For exports, set `BRAIN_EXPORT_REPOSITORY` to a **private** `owner/repository`, `BRAIN_EXPORT_BRANCH` to its existing branch, and `BRAIN_EXPORT_GITHUB_TOKEN` to a GitHub credential scoped only to that repository with **Contents: read and write**. Store it as a sensitive Vercel environment variable. Maintenance does not require an agent token or GitHub Actions secret.

**Database backup runs independently on Neon at 03:00 UTC:** native daily snapshots with seven-day retention cover auth, vectors and database history. Git export provides portable knowledge and daily content history; Neon snapshots protect the database. Snapshot scheduling and restore access remain Neon responsibilities.

## Deployment

Configure the application environment values in `.env.example` and bootstrap the owner after the initial migration. Vercel runs `vercel-build`, which applies native Drizzle migrations before building Next.js. Existing installations must first complete the [one-time baseline registration](docs/database-migrations.md#existing-installation-one-time-adoption). Vercel's Git integration deploys production from `main`; work on a feature branch, verify its changes, then merge through the repository workflow. Do not manually deploy a feature branch to production. Maintenance needs `CRON_SECRET`, `AI_GATEWAY_API_KEY`, and the export repository credential on Vercel. Query retrieval uses its separate `BRAIN_EMBEDDING_API_KEY`. The Next.js configuration integrates the Vercel Workflow compiler and runtime routes.

The `0001_remove_retired_storage` migration removes single-page vector columns and retired GitHub jobs, including their executor and lease fields. Apply it together with this application version while requests and maintenance are paused: the previous version still accesses the removed columns. Canonical pages and chunk embeddings are retained; pages awaiting complete chunk indexing remain searchable by text until indexed. See [database previews](docs/database-preview.md) for environment isolation and preview cleanup.

The application derives its production origin from Vercel's `VERCEL_PROJECT_PRODUCTION_URL` and its preview origin from `VERCEL_URL`. Enable Vercel's system environment variables; a missing selected domain leaves authentication unconfigured rather than falling back to another deployment. `BETTER_AUTH_URL` is used only locally or outside Vercel production/preview. Redirect alternate production domains to the project domain (`https://agent-brain.vercel.app`) in Vercel so browser sessions, OAuth discovery and the MCP resource use the same origin. Changing that canonical domain changes the OAuth issuer and MCP audience: reconnect existing OAuth agents using the new canonical `/mcp` URL.

The production origin must be reachable without a Vercel team login; application auth protects all data. Keep previews protected. Verify unauthenticated MCP challenges, OAuth discovery and an authenticated tool invocation. Trigger maintenance from Operations, inspect the durable run and job results, and verify the exported commit in GitHub. Enable native snapshot scheduling in Neon and read back the schedule before marking backups configured. Check Neon for individual snapshot success; a configured schedule is not proof of a completed backup.

No periodic export/import test is required or scheduled.

## References

Design references: [GBrain](https://github.com/garrytan/gbrain), [Munin Memory](https://github.com/Magnus-Gille/munin-memory), [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) (path verified), and [Supermemory](https://github.com/supermemoryai/supermemory). This implementation uses entity pages without a third-party memory platform.

Protocol and storage: [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Better Auth MCP](https://www.better-auth.com/docs/plugins/mcp), [pgvector](https://github.com/pgvector/pgvector), [AI Gateway embeddings](https://vercel.com/docs/ai-gateway/modalities/embeddings). No unverified quotation from Karpathy's wiki pattern is included.
