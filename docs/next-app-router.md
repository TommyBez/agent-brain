# Rendering and navigation

Next.js 16.3 runs this application with `cacheComponents: true` and `partialPrefetching: true`. `app/(workspace)/layout.tsx` owns the shared chrome. Pages own their data dependencies and loading UI, so a shared layout never hides the destination behind a session or database read.

| Route | Immediate shell | Streamed server content | Client interaction |
| --- | --- | --- | --- |
| `/` | Library heading, navigation, statistics and list placeholders | Owner statistics; filtered, sorted, paginated pages | Search, type and sort controls update URL |
| `/graph` | Heading and graph placeholder | Owner-scoped graph snapshot | Node selection, local graph filter, reset |
| `/activity` | Heading and activity placeholder | Audit entries and page links | Refresh |
| `/pages/[id]` | Back navigation, heading/body/connection placeholders | Markdown, metadata, typed links and backlinks | Next Links |
| `/pages/new`, `/pages/[id]/edit` | Editor heading and placeholder | Initial page and relationship choices | Draft, preview, duplicate hints, save, conflict reconciliation |
| `/pages/[id]/history`, `/pages/[id]/history/[version]` | Back navigation and history placeholders | Revisions and immutable snapshot content | Next Links |
| `/agents` | Heading, OAuth connection instructions | Token metadata, authorized settings | Credential forms, copy controls, password form |
| `/operations` | Heading and status placeholder | Current checks, jobs and reports | Start maintenance; refresh while work is active |
| `/sign-in`, `/consent` | Authentication/consent copy | Consent identity and permissions | Better Auth forms |

Keep each asynchronous or URL-dependent read under a Suspense boundary within its page. A boundary above the shared layout cannot provide the loading UI for sibling navigations. Do not add `loading.tsx`, `instant = false`, `force-dynamic`, or blanket cache bypasses to silence a rendering error.

## Data and mutation boundaries

`lib/workspace/session.ts` uses React request memoization to avoid duplicate session work in one render. Every exported knowledge getter verifies that session, then passes the stable owner ID into an unexported `use cache` function. Authentication is never cached across requests; cache keys never contain credentials. Renderers share data through the server data layer, without a browser fetch or a round trip to their own Route Handlers.

The owner-wide tag covers lists, counts, page bodies, graph, backlinks, revisions and activity. A write can affect all of them. Browser Server Actions use `updateWorkspaceCache` after the transaction commits, providing read-your-writes. Existing HTTP APIs, remote MCP tools and Workflow steps use `revalidateWorkspaceCache` with immediate expiration. The core brain service remains independent of Next.js so agent and database tests can run directly.

Knowledge reads advertise a 30-second client freshness window. A remote agent's mutation invalidates the server cache but does not send a push message to an open tab. A new server request sees the invalidated data; Back/Forward can restore an existing view, and shared layouts are not refetched on every navigation. Refresh the view to request current server state. The editor always submits `expectedVersion`; conflict reconciliation reads the committed database version directly, preserving the user's draft.

Full token values are returned only when creating a token, through its Server Action or the compatible HTTP endpoint. Subsequent reads contain metadata only. Token metadata and operations status are read fresh on the server. Sign-out navigates to a new document to discard authenticated router state.

## Verification

Run `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`. Database tests must use a separate Neon test branch. The rendering build should report the workspace routes as partially prerendered; both shell and dynamic parts are intentional.

The HTTP acceptance suite exercises a running Next server without importing or mocking its handlers: rendered HTML, streaming while a database query is blocked, API/MCP cache invalidation, revisions, and authorization after caches are warm. It is skipped by `pnpm test` unless `RUN_NEXT_TESTS=1`.

Prepare a separate fixture owner whose email ends in `.invalid`, and run a Next build/server against that isolated test database with `BETTER_AUTH_URL` matching its loopback origin. The HTTP server and the cleanup database connection must refer to the same fixture. Put the following in a gitignored `.env.next-test`, replacing the placeholders with that fixture's values:

```dotenv
BRAIN_TEST_BASE_URL=http://localhost:3000
BRAIN_TEST_EMAIL=owner@example.invalid
BRAIN_TEST_PASSWORD=replace-with-fixture-password
BRAIN_TEST_DATABASE_URL=postgresql://test_owner:replace-with-test-password@TEST_BRANCH_HOST/neondb?sslmode=require
```

With that test server already running:

```sh
RUN_NEXT_TESTS=1 node --env-file=.env.next-test --import tsx --test tests/navigation.integration.test.ts
```

This suite creates temporary pages and a scoped token, then cleans up its exact fixture IDs. It only accepts a loopback HTTP origin and the dedicated `.invalid` owner; it must not point at the normal application's production database. HTTP acceptance establishes server behavior, while browser interaction and paused-shell inspection remain separate checks.

Verify the actual browser journeys as well:

- Open and refresh a deep page URL. Follow links between library, entities, connections, revisions and settings; use Back and Forward.
- Search, change type/order, navigate to a different collection before debounce completes, and check that URL and input stay in sync.
- Save from the editor and from Markdown preview; revisit New page and confirm the completed draft is reset. Cancel an edit and reopen it.
- Save concurrently through an agent/API and the editor. Confirm stale writes are rejected, the draft survives, and reconciliation uses the latest version.
- Create and revoke a disposable test token; refresh Operations without triggering external maintenance.

In `next dev`, open **Next.js DevTools → Navigation Inspector → Pause on navigations**. Inspect both a page reload and a link navigation while dynamic content is paused. Navigation, destination headings and local placeholders must remain visible. Resume to confirm that protected content streams into those placeholders. Inspect a dynamic `/pages/[id]` URL as well as the library and fixed routes. Turn the pause toggle off afterward: its testing cookie is shared across localhost ports.

Production prefetching is evaluated with `next build` and `next start`; a successful development navigation alone does not prove that prefetching works in production. The built application must still enforce owner authorization after caches are warm.

Framework references: [Next.js 16.3 Instant Navigations](https://nextjs.org/blog/next-16-3#instant-navigations), [authentication with Cache Components](https://nextjs.org/docs/app/guides/authentication-with-cache-components), and [instant navigation verification](https://nextjs.org/docs/app/guides/instant-navigation). The versioned source of truth is `node_modules/next/dist/docs/`.
