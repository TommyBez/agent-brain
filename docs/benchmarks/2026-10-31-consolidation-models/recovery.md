# Consolidation recovery — 31 October 2026

The seven audited runs from 25–31 October were partial. They recorded 5,085 new
analyses, 60 `max_tokens_exceeded` errors, two `choice_not_max` errors and four
applied links. No text proposal was applied. The last run stopped after three
capacity failures, leaving 1,646 tasks queued.

Source comparison confirmed that the 19 October deployment contained runner
isolation and lossless verifier recovery absent from the Git revision deployed
on 30 October (`02e6c4680d4b672b48e6c3c349e8e8d2f6cee57d`, task manager PR #36).
The earlier deployment did not expose a source SHA; this identifies the
divergence without attributing it to a particular author or command.

## Changes

- A deterministic input-capacity failure cannot trip the global three-failure
  provider outage cutoff. Actual repeated provider failures still stop dispatch.
- Verification can share repeated text and alias identifiers reversibly. The
  encoded questions are batched again after transformation; all evidence and
  checks remain present. Failed recovery cannot authorize a write.
- Unchanged analysis and proposal capacity blocks are reused by source
  fingerprint and `CAPACITY_POLICY_VERSION`; a changed policy or source retries
  them. Cached blocks remain visible as partial/capacity in Operations.
- Successful recursive evaluation parts are persisted independently. A later
  failed part does not discard them, and partial aggregates are never cached.
- Invalid drafts return their exact deterministic defect for the existing one
  repair. Unknown technical errors remain technical. `REPAIR_POLICY_VERSION`
  retries historical rejected proposals once without invalidating successful
  analyses or semantically uncertain decisions.
- Operations distinguishes provider, budget, technical, capacity, changed
  snapshot and run-limit outcomes, with queued and reused task counts.

No schema migration, production model replacement or threshold change is part of
this patch. Old audit records remain intact. The former capacity decisions and
rejected drafts are recovered through normal cache-version invalidation, not
database deletion.

## Validation

The runner isolation, lost capacity classification, failed-subpart cache and
post-compaction batch-size regressions were reproduced before their fixes.
Unit tests cover the repaired cases, evidence/version invalidation, full
preservation checks and bounded retry feedback.

The isolated PostgreSQL 17 + pgvector suite passed 27/27 integration tests with
no skips, including the production workflow steps with provider mocks. The audit
step suite was repeated after adding precise draft feedback and passed 4/4.
Authenticated local Operations checks passed six DOM assertions and confirmed
the capacity counter and stop reasons, with no Next runtime errors. No live AI
calls or production data writes were used in these integration/UI tests.

## Decisions and outstanding measurements

The [model benchmark](README.md) includes the 16 explicitly authorized real cases
and 24 synthetic cases. Decider handles the four capacity stress inputs but
produces one high-confidence false positive against the independent objective
label. Jev remains the production evaluator. A larger independent holdout and
complete preservation/provenance gates are needed before replacing it.

The blind review also found generic centralization goals and possible context
or attribution drift. Exact draft feedback addresses deterministic patch
failures; it does not solve semantic planning. Fact-level move/keep objectives
and destination suitability need separately labeled validation. The current
thresholds continue to prevent unverified text writes.

Exhaustive page-pair generation remains quadratic. Reducing candidate pairs
requires a recall benchmark against that existing coverage. Split-cache reuse
removes a confirmed source of repeated work; actual duration and cost savings
must be measured on subsequent production runs. Unknown provider costs remain
unknown rather than being reported as free calls.

Deployment readiness is not proof of a completed production maintenance run.
After release, verify the deployed Git SHA, the authenticated Operations result
and terminal job records, especially capacity/error separation and queue
progress. Do not report the recovery complete while that workflow is active.
