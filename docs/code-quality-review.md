# Code quality review follow-up

The refactor addresses the six structural blockers and shared-helper findings while preserving versioned writes, owner isolation, model I/O validation, atomic consolidation, and incremental maintenance budgets.

| Finding | Result |
| --- | --- |
| Brain service module | Public facade plus pages, search, context, analysis, history, indexing, and consolidation modules. Shared hydration reads page rows and decorated links in two queries. Context hydration uses one repeatable-read transaction. Outgoing links resolve and insert in batches. |
| MCP scope drift | One tool-definition table supplies registration, handler authorization, and route scope lookup. Regression coverage enumerates every registered tool and checks rejection before execution. |
| Analysis kind-switch | Finding handlers share localization/preparation and one evaluation helper. Incomplete evaluation throws a sentinel caught once; link choices use the canonical type guard. |
| Nested consolidation attempts | Attempts return outcomes; task processing accumulates them; one terminal pass invalidates completed tasks against changed pages. Scan returns its reuse verdict and prepared plans. |
| Graph canvas | Camera math, simulation lifecycle, gestures, and SVG rendering have separate owners. Gesture code uses pin/dragTo/unpin. The graph model is memoized independently of hover. Invalid edges fail before layout initialization. |
| Editor draft duplication | One typed draft and draftFromPage supply initialization and resets. Duplicate checks, connections, and Markdown tabs are separate components. Automatic form reset is prevented so failed actions preserve the displayed page type as well as React state. |

Canonical JSON/fingerprints, Retry-After parsing, owner checks, OAuth read/write scopes, pagination, page/link enums, page size, embedding predicates, evidence projections, and consolidation record names now have shared definitions. Export uses the shared API error boundary. Revision lists omit snapshots; `/api/brain/pages/[id]/revisions/[version]` fetches one snapshot on demand. Base and decorated links have distinct contracts. Dead exports, the identity type alias, and pass-through imports were removed.

Schema definitions are split into auth and brain modules with enum checks generated from canonical constants. No schema migration is needed. The large store integration test is split into snapshot, apply, reuse, and audit suites. Editor reference parsing/validation and GitHub transport are also separated from their orchestration modules. Collection paths drive one generic route.

## Preserved runner ordering

The proposed analyze-all-then-apply phases are not behavior-neutral: existing tests require skipping later overlapping analyses after a write and stopping promptly at the daily budget. The refactor retains sequential interventions over the immutable snapshot, with explicit attempt outcomes and one final invalidation pass. It does not add concurrent model calls or change policy thresholds.

## Local validation

- Database-backed suite after cleanup: 255 tests, 251 passed, four opt-in checks skipped, no failures. A disposable pgvector database was migrated using the existing migrations.
- Running Next HTTP acceptance suite: all 16 checks passed. After the collection Suspense fix, all eight navigation checks passed again. This covers typed collections, private HTML, histories past 50 revisions, blocked-query streaming, API/MCP cache invalidation, unauthenticated access, and summary/single-revision payloads.
- Lint, TypeScript, and schema/migration alignment passed. Turbopack production build passed.
- Scoped browser with a disposable owner: pagination/query/sort retention, registered Command-K focus, duplicate detection, Markdown preview, metadata and connection saving, conflict/draft preservation, reconciliation, and Activity-retained editor state were exercised. Graph selection, keyboard controls, hover, drag, pan, search emphasis, filtering, zoom controls, fit, shuffle, and native wheel handling were checked. The CLI wheel command did not deliver an event to the canvas; dispatching a native WheelEvent verified the handler and camera update.

The collection parameter read lives in a suspended child with a visible heading/card fallback, following the Next.js URL-data Insight pattern. Paused reload and client navigation captures showed meaningful shells; resuming produced Projects/Notes content. The targeted URL-data Insight cleared. A separate current-time Insight surfaced inside the existing Better Auth session lookup in `lib/auth.ts`; it remains outside the requested focused Suspense fix.

Validation is local. No production model run, export, deployment, or publication was performed.

## Approved review cleanup and deploy notes

The follow-up removes the unused graph pagination flag, derives prompt registration and route authorization from scoped prompt tuples, derives remaining OAuth scope arrays from the canonical scopes, removes snapshot/projection re-export aliases and the dead references export, hashes change-set IDs through fingerprint, and moves RunnerSteps/Scan/PlannedTask into the shared types module. The search hook retains its tested cancellation behavior and has an explicit reducer TODO.

Canonical JSON uses deterministic UTF-16 key ordering. The previous store serializer used localeCompare, while snapshot fingerprints already used UTF-16 ordering. Historical store fingerprints whose key order differs, and change-set IDs previously built from raw JSON.stringify, can change. Allow for one-time cache misses and additional analysis within the existing budget after deployment; do not assume every snapshot ID changes. Apply receipts and version checks remain in force.

The shared HTTP API now emits INVALID_INPUT, REQUEST_TOO_LARGE, and INVALID_REQUEST instead of validation_error, request_too_large, and invalid_request. External clients matching these literal codes must be updated. OAuth authentication errors retain their protocol codes.
