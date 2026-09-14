# Agent Brain

A private, agent-native second brain. One canonical Markdown page per person, client, project, article, decision or note, connected by typed links. Postgres is the source of truth. Conversations happen in your agent; this application stores, validates, organizes and retrieves knowledge.

The Next.js server never calls a model. Remote MCP is the primary interface. The browser provides a knowledge desk for reading, editing, graph navigation, revisions, credentials and operational status.

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
RUN_DB_TESTS=1 pnpm test
pnpm build
```

Integration tests use isolated owner IDs and remove only their own fixtures. SQL migrations use advisory locking and immutable checksums; run them explicitly before deploying, using the direct database URL.

## Connect an agent

Connect to `https://YOUR_DOMAIN/mcp` using Streamable HTTP. Interactive clients discover OAuth metadata and use authorization code + PKCE, explicit consent and refresh tokens. Better Auth's dedicated MCP and CIMD plugins support HTTPS client metadata documents; dynamic registration supports clients without CIMD. MCP SDK v2 provides stateless transport and compatibility with earlier protocol clients.

Create headless tokens in **Agents & settings**, with only the scopes needed:

```json
{
  "mcpServers": {
    "brain": {
      "type": "http",
      "url": "https://YOUR_DOMAIN/mcp",
      "headers": { "Authorization": "Bearer YOUR_AGENT_TOKEN" }
    }
  }
}
```

Configuration formats differ between agents; the URL and Bearer header are standard. Tokens are shown once, stored only as hashes, scoped, expiring and revocable. Nightly maintenance needs `brain:read`, `brain:write`, and `brain:maintain`.

| Primitive | Behavior |
| --- | --- |
| `resolve` | Canonical names/aliases and fuzzy candidates; Postgres enforces identity uniqueness. |
| `read` | Full page, version, links and backlinks in a consistent snapshot. |
| `write` | Atomic replacement of page, aliases and outgoing links; current ID and expectedVersion required. Create with version 0. |
| `append` | Version-checked append with provenance; invalidates obsolete embeddings. |
| `search` | Weighted full text + optional vectors, reciprocal-rank fusion and graph expansion. |
| `related` | Bounded traversal of typed edges. |
| `context` | Sized Markdown evidence bundle with references, versions, links, gaps and retrieval mode. |

Maintenance tools expose paginated pages, gaps, pending embeddings and version-checked embedding attachment. Procedures are MCP instructions, resource `brain://procedures`, and prompts `before_work`, `after_conversation`, `nightly_consolidation`. The canonical procedure text lives in `lib/mcp/server.ts`; the portable skill refers to these prompts.

All tools scope data to the authenticated owner. Foreign keys prevent cross-owner links. Accepted writes create full revisions and audit entries. On conflict, reread and reconcile. `write` replaces aliases, tags and outgoing links, so callers must preserve existing values deliberately.

## Retrieval

The separate runner uses `openai/text-embedding-3-small` through AI Gateway, with 1536 dimensions. Agents can also attach embeddings when writing and supply query embeddings to search/context. The server validates dimensions, model and page version. Without a query vector, retrieval uses text and graph and explicitly reports that mode.

Postgres indexes include weighted language-neutral full text, trigram names, HNSW cosine vectors and graph edges. Context budgets count characters. `read` returns complete pages; nightly embedding inputs use the title, summary and beginning of the Markdown, bounded to 7,500 UTF-8 bytes per page. One vector represents each page, so semantic retrieval does not cover the remainder of long pages. Writes become searchable by text immediately; vector freshness follows the nightly worker. Changing dimensions requires a migration and re-index.

## Nightly maintenance, export and backup

1. **02:00 UTC — Vercel Cron:** authenticated `/api/cron/nightly` creates idempotent consolidation and export jobs, with no inference.
2. **02:45 UTC — private GitHub runner:** `scripts/nightly-agent.mjs` claims expiring exclusive leases. DeepSeek `deepseek/deepseek-v4.1-flash` through AI Gateway reviews gaps and makes bounded, version-controlled improvements. It embeds updated pages, then exports consistent Markdown plus graph data into daily Git commits. Consolidation and export failures are independent. Only successful pushes acknowledge exports.
3. **03:00 UTC — Neon:** native daily database snapshots, seven-day retention, independent of the app and runner. These cover auth, vectors and database history. Git export is the exit door, not the backup.

Install `docs/nightly-workflow.yml` as `.github/workflows/nightly.yml` in a **private** export repository. Copy `scripts/nightly-agent.mjs` to its root, install pinned `@modelcontextprotocol/client@2.0.0`, and commit the lockfile. Set variable `BRAIN_URL`, encrypted secrets `BRAIN_AGENT_TOKEN` and `AI_GATEWAY_API_KEY`. The workflow refuses public repositories and commits only `export/`, using GitHub's ephemeral job credential.

Consolidation and Git export run in separate workflow jobs. Only consolidation receives the AI Gateway key; export receives no model credential and still runs if consolidation fails. Native Neon backups use neither job nor key.

The runner is portable and separate from Next.js. Vercel Cron supplies its durable daily work queue. Failed jobs allow four claims. GitHub schedules can run late; queued jobs survive until processed. AI Gateway has a $5/month key cap; no automatic top-up is configured. Application deployment needs neither the model key nor a model SDK.

## Deployment

Use the same region for Vercel and Neon (`fra1` / `aws-eu-central-1`). Apply migrations, bootstrap the owner, configure application environment values, and deploy with `vercel --prod`. Exclude runner credentials from the application environment. `BETTER_AUTH_URL` must be the stable production origin.

The production origin must be reachable without a Vercel team login; application auth protects all data. Keep previews protected. Verify unauthenticated MCP challenges, OAuth discovery and an authenticated tool invocation. Enable native snapshot scheduling in Neon and read back the schedule before marking backups configured. Check Neon for individual snapshot success; a configured schedule is not proof of a completed backup.

No periodic export/import test is required or scheduled.

## References

Design references: [GBrain](https://github.com/garrytan/gbrain), [Munin Memory](https://github.com/Magnus-Gille/munin-memory), [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) (path verified), and [Supermemory](https://github.com/supermemoryai/supermemory). This implementation uses entity pages without a third-party memory platform.

Protocol and storage: [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Better Auth MCP](https://www.better-auth.com/docs/plugins/mcp), [pgvector](https://github.com/pgvector/pgvector), [AI Gateway embeddings](https://vercel.com/docs/ai-gateway/modalities/embeddings). No unverified quotation from Karpathy's wiki pattern is included.
