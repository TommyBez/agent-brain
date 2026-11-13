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
error, invalid response, simulated gateway timeout, and propagation of save failures.
The timeout test injects an already-aborted signal and a thrown TimeoutError;
it does not measure expiration of the configured eight-second deadline.
Controlled judgments test transport/policy rather than semantic accuracy.

M1 is now covered by the static test **`write/append tool descriptions preserve
history/log rules and advisory JEV feedback`** in `tests/brain-instructions.test.ts`.
It parses the actual `lib/mcp/server.ts` descriptions and requires history/log,
durable-fact and single-state guidance plus advisory JEV score/feedback wording
for both tools. It first failed because write lacked the history/log rule; after
clarifying the descriptions, it passes. This is static content coverage, not
behavioral evidence that an agent follows F7. Neither the helper tests in (a) nor
the agent eval in (b) exercise those production descriptions: (b) advertises the
separate descriptions from `scripts/skill-eval/brain.ts` (FakeBrain).

The live synthetic eval separately sends all five acceptance examples to actual
JEV on each of the six page types: **30/30 pass**, no missing judgments.
All 18 dated-fact examples have no feedback (score 0.01–0.02); all 6 dated-update
appends warn (0.95–0.97); all 6 writes with `Stato precedente` warn (0.57–0.76).
Raw requests/responses, timing and expected/observed outcomes: `examples.json`.
No real Brain, database, exports or agent-brain-memory repository is used.

## (b) Three syncs, one synthetic project

### New run: senza istruzione di correggersi

Agent: repository editor model `deepseek/deepseek-v4.1-flash-1017`, temperature 0.
One fresh run, no retries: the same in-memory `project/iris` moves from Prototipo
to Beta interna, Pilota con tre clienti, Rilascio pubblico. Every sync preserves
`kick off del progetto il 20/02/2025` without feedback on the valid rewritten page.

M2: the eval-specific prompt no longer says to correct after feedback, reread or
conclude. Its complete form is `Sync N: Iris ora ha questo stato: STATE Aggiorna
la pagina conservando i fatti storici. Non è una nuova decisione.` The ordinary
production `BRAIN_INSTRUCTIONS` remain present, including #41's history/log rules;
there is no added instruction in the prompt or setup to react to JEV or repair a
page. The corrective advice reaches the agent only inside the JEV-enriched tool
result. Setup, actual prompts, tool definitions, JEV requests/responses, tool
inputs/outputs, agent responses and page snapshots are archived in
`syncs-without-correction-instruction.json`.

The initial `## Aggiornamento 12/11\nBeta interna.` append is still a **seeded
fault injection**, not a naturally observed agent mistake. No harness edit repairs
the page. Non-recovery would be saved as an outcome: the runner records all three
syncs before asserting the final state-section limit, without a repair prompt,
forced write or selective rerun.

- **Sync 1:** seeded append score **0.97**, with the exact feedback below. The next
  agent response calls `read` (v2), then the following response calls `write` (v3)
  to replace both old state and dated update with `## Stato\nBeta interna.`.
  This write scores **0.03**, no feedback; the next response concludes.
- **Sync 2:** after reading v3, writes v4 with `Pilota con tre clienti.`; score
  **0.03**, **no feedback**. The next response concludes with the saved state.
- **Sync 3:** after reading v4, writes v5 with `Rilascio pubblico.`; score
  **0.02**, **no feedback**. The next response concludes with the saved state.

Exact feedback on sync 1 (all subsequent writes have no feedback text):

> Stai facendo un log: riscrivi lo stato nella sua unica sezione al suo posto con write, preservando fatti storici, fonti, metadati e link. Non declassare lo stato vecchio a ‘Stato precedente’. Rileggi la pagina e usa la versione corrente prima di correggerla. La scrittura è già riuscita; questo è solo feedback.

**3/3 syncs completed**, each snapshot has **1 state section** and retains the
historical fact. The deterministic final assertion `stateSections <= 1` **passes**;
no dated update or `Stato precedente` remains. Final page (v5):

```markdown
# Iris

kick off del progetto il 20/02/2025

## Stato
Rilascio pubblico.
```

This is an in-memory tool-result eval using the production feedback helper and
FakeBrain, not a deployed MCP/DB or native Codex client verification. There is no
no-feedback control; baseline production writing guidance is still present. The
observed recovery is not proof that feedback alone caused it, nor evidence of
behavioral coverage for the production write/append descriptions.

### Previous run: con istruzione di correggersi

`syncs.json` is retained only as the **con istruzione di correggersi** comparison.
Its user prompt explicitly said: `Dopo eventuale feedback correggi al turno
successivo, rileggi e poi concludi.` Thus recovery in that run depended on both
the feedback and an explicit evaluation instruction; it cannot establish an
autonomous response to feedback. Scores: sync 1 **0.97** on the seeded log, then
**0.03** after read/write recovery; sync 2 **0.02**; sync 3 **0.03**. It also ends
with one state section and the same historical fact. The old run is not reused
as the new run's evidence.

## (c) Local checks and skill comparison

Local full suite: **469 passed, 34 skipped, 0 failed (503 total)**. Lint,
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

**PE proposal, pending the PM's decision:** use static identity of skill and
`BRAIN_INSTRUCTIONS` plus the separate JEV eval for (c), without extending the
harness in PR2. This is not a decision attributed to Tommy or the owner. No harness
bypass or substituted baseline was applied. With identical measured inputs and
simulator, no regression attributable to PR2 is possible within what this harness
measures; this is not empirical equivalence of stochastic agent outcomes.

The only changes to static agent-facing prompts are the write/append descriptions
(F7). Their text now has the M1 static test above; their behavioral effect and
runtime-feedback coverage in skill-eval remain a follow-up. The 30 historical
semantic examples and the two labeled sync runs are separate evidence, not proof
of F7 behavior. Even an A/A repetition would show variance and could not prove
equivalence from a small sample.

Validation CI on code/report SHA `1d8ad9cc422aeead137345e1586baf28179a6e8d` passed
all three checks. CI for this follow-up's new HEAD is recorded separately in the
PR body once verified; that older green SHA is not proof of the new HEAD.

## Cost, latency and limitations

The original semantic examples plus the run **con istruzione di correggersi**
produced the 34 JEV calls below. The new run **senza istruzione di correggersi**
adds **4 JEV calls**, with median **264 ms**, minimum **233 ms**, maximum **772 ms**
and total JEV cost **$0.000113904**. These are separate samples; they exclude agent
chat inference cost and do not establish production latency or realistic-page cost.


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

## Non-blocking follow-ups (PM decides)

- **M3:** content-free fail-open diagnostics and measurements on realistic pages
  to inform the two-week reassessment; no page content in diagnostic logs.
- Behavioral F7 coverage and skill-eval support for production tool descriptions
  and runtime feedback. M1's static wording coverage is now implemented.
- **m1:** a timeout test that verifies actual deadline expiration.
- **m3:** duplicated write payload and behavior with preexisting logs.
- **m4:** response latency up to eight seconds.
- **m5:** integration coverage for the `server.ts` wiring.
- **Nits:** inline 0.5 threshold, dead answer-type guard, and tautological six-type
  loop with fixed mocked judgments (not semantic/type-specific coverage).

## Reproduction

With the repository's existing AI Gateway environment configured:

```sh
node --import tsx --test tests/brain-instructions.test.ts tests/write-feedback.test.ts
node --import tsx scripts/evaluate-write-feedback.ts .evals/write-feedback --syncs-only
pnpm test
pnpm lint
pnpm typecheck
pnpm db:check
```

All evaluation pages are synthetic; the live runner imports no Brain database
service and performs no DB operation. It uses the existing model constant,
Gateway, MCP instructions and FakeBrain tool definitions.
