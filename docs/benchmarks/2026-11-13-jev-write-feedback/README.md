# PR2: JEV write/append feedback

## Scope and protocol

After a successful MCP `write` or `append`, call the existing
`evaluateJev` (`typesafe-ai/jev-1.14.0`) with the saved page and the change.
Return `writeEvaluation.score` (probability of a log, 0–1), and corrective
`feedback` when score ≥0.5, in both MCP text and structured data. This threshold
only selects feedback; it never gates a mutation. No judgment is persisted.

Evaluation runs after commit, outside the save's error boundary. Errors, missing
configuration, invalid responses, context-capacity rejections and gateway timeout
return the original successful page without `writeEvaluation`. The existing
gateway receives an 8-second abort signal; there is no retry or second deadline
implementation. Save/version/auth errors still fail normally. Consolidator and
non-MCP writes are untouched. F7 clarifies that append is for new knowledge,
not state or sync logs; use write to replace the single current-state section.

## (a) Tests and live examples

`tests/write-feedback.test.ts`: 4 passing tests, covering 6 page types × 5
controlled judgments, append context and save-before-evaluation order, provider
error, invalid response, gateway timeout, and propagation of save failures.
Controlled judgments test transport/policy rather than semantic accuracy.

The live synthetic eval separately sends all five acceptance examples to actual
JEV on each of the six page types: **30/30 pass**, no missing judgments.
All 18 dated-fact examples have no feedback (score 0.01–0.02); all 6 dated-update
appends warn (0.95–0.97); all 6 writes with `Stato precedente` warn (0.57–0.76).
Raw requests/responses, timing and expected/observed outcomes: `examples.json`.
No real Brain, database, exports or agent-brain-memory repository is used.

## (b) Three syncs, one synthetic project

Agent: repository editor model `deepseek/deepseek-v4.1-flash-1017`, temperature 0.
The same in-memory `project/iris` moves from Prototipo to Beta interna, Pilota con
tre clienti, Rilascio pubblico. It retains `kick off del progetto il 20/02/2025`.

The first append is a **seeded fault injection**, not a naturally observed model
error: `## Aggiornamento 12/11\nBeta interna.`. This guarantees a feedback response
even if #41's instructions would prevent the agent from writing a log by itself.
JEV returns score **0.97** and the corrective feedback. In the next agent response
it calls `read`; in the following response it calls `write` at the fresh version
and replaces both old state and dated update with `## Stato\nBeta interna.`.
The corrected write scores **0.03**, without feedback. Sync 2 scores **0.02**;
sync 3 **0.03**, both without feedback. Every corrected write keeps the historical
fact. No fixed corrective text is applied by the harness: the model chooses the
replacement Markdown. Raw JEV responses, tool inputs/outputs, agent responses
and the final page are in `syncs.json`.

The runner deterministically asserts current state and history preservation after
every sync and at most one state/update heading. Final page: **1 state section**,
no `Stato precedente` or dated update. Archived trace also passes these checks.

```markdown
# Iris

kick off del progetto il 20/02/2025

## Stato
Rilascio pubblico.
```

This is an in-memory tool-result eval using the production feedback helper and
existing FakeBrain, not a deployed MCP/DB or native Codex client verification.
It demonstrates recovery after injected feedback, not that feedback alone caused
recovery compared with a no-feedback control.

## (c) Local checks and skill comparison

Local full suite: **468 passed, 34 skipped, 0 failed (502 total)**. Lint,
typecheck and `pnpm db:check` pass. The latter is static schema/migration
alignment, not a migration or database execution. Lint reports two existing
unused-suppression warnings and an existing large-JSON informational message.

After #41 was squash-merged, `origin/main` is
`2c81932562b520a184a1230e0461144b7924c7cf`. The branch was updated with a clean
merge (no rebase or force push), producing `b503d780a8f52d4f101c14110baa599c1234a286`.
The merge changes no tracked content relative to the pre-merge PR2 tree.
PR #42 now targets main and its remote diff contains only the seven PR2 files.

A fresh prepare against this main on the new HEAD was attempted:

```sh
node --import tsx scripts/evaluate-brain-skill.ts prepare \
  --out .evals/pr2-skill-main-fresh --baseline-ref origin/main \
  --comparison full --mode loaded \
  --model deepseek/deepseek-v4.1-flash-1017 --repeats 1
```

It exits 1 before registering any trials: **“The two arms are identical; select a
baseline before the change.”** (`scripts/evaluate-brain-skill.ts:338–343`).
The existing full comparison extracts only skill files and `BRAIN_INSTRUCTIONS`;
these are identical after #41's squash. It uses its own tool descriptions and
FakeBrain, so it does not observe PR2's MCP descriptions or runtime feedback.
**New comparison: 0 trials, 0 reviews; behavioral non-regression not demonstrated.**
The interrupted comparison against pre-#41 main is excluded and not reused.

Per the brief's conflict rule, implementation is paused pending an owner decision:
extend the harness to exercise runtime feedback, or explicitly accept static
identity plus the separate JEV eval. No harness bypass or substituted old baseline
was applied. Identical inputs are evidence of unchanged skill/instruction text,
not empirical evidence that a stochastic agent will perform identically. Even an
A/A repetition would show variance and could not prove equivalence from a small
sample. CI on merge HEAD was still running when this report was updated.

## Cost, latency and limitations

One additional JEV call with one boolean question per successful MCP write/append;
no added DB query, spend insert, job, migration, cache or retry. With the small
synthetic pages above: **34 calls**, median **236 ms**, p95 **510 ms**, maximum
**524 ms**; provider-reported cost **$0.000027174–$0.000028560 per call**, total
**$0.000939204**. These measurements are illustrative, not production percentiles.
Cost grows with context. Existing JEV policy rejects requests over 100,000 JSON
characters or its token capacity; oversized pages still save without feedback.
Write requests include the Markdown in page and change, so this limit can be
reached before the 200,000-character page limit. At 8 seconds the gateway aborts
and the successful write is returned without evaluation; this is not a hard
wall-clock SLA for serialization/event-loop delay. Existing provider credentials
and limits apply; interactive judgments are not added to nightly spend records.

False positives/negatives and nondeterministic judgments remain possible. The
0.57 decision-page score for `Stato precedente` shows a margin close to the 0.5
feedback threshold. Advice can be ignored and errors are intentionally silent in
the mutation result. Model cost and added response latency affect every successful
MCP write/append, including clients with the task manager off. Rollback is code
only. No blocking is enabled; reassess blocking after the two-week observation
period. Merge remains with Tommy via Chief after PM confirmation.

## Reproduction

With the repository's existing AI Gateway environment configured:

```sh
node --import tsx --test tests/write-feedback.test.ts
node --import tsx scripts/evaluate-write-feedback.ts .evals/write-feedback
pnpm test
pnpm lint
pnpm typecheck
pnpm db:check
```

All evaluation pages are synthetic; the live runner imports no Brain database
service and performs no DB operation. It uses the existing model constant,
Gateway, MCP instructions and FakeBrain tool definitions.
