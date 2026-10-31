# Jev 1.14.0 vs Perplexity Decider v1.2

Measured on 2026-10-31 through Vercel AI Gateway `/v1/evaluate`. This is a
component benchmark of identical requests, not an end-to-end consolidation run.
No Brain data was changed and no production model was switched.

## Protocol fixed before the calls

- 24 labeled synthetic cases: 16 factual-integrity cases, 4 deduplication
  objectives and 4 resolution choices. Twenty boolean labels (6 positive,
  14 negative) plus four categorical labels. Two repetitions per model.
- 12 real requests from the audited account's 25–31 October consolidation
  records: 4 verification objectives, 4 screening requests and 4 choice
  requests. One execution per model.
- 4 capacity stress requests reconstructed from immutable 30 October
  snapshots of tasks that had failed with `max_tokens_exceeded`. Replay used
  already-persisted judgments until the first missing request; that full request
  is sent unchanged to each model. One execution per model.
- Same state, questions and ordering for both models. Model order alternates
  between cases. No automatic retries, fallbacks, recursive question splitting,
  editor calls or writes. The existing production parser checks each response.
- Synthetic integrity threshold 0.65; objective and categorical selection
  thresholds 0.80. No threshold or prompt was tuned after seeing predictions.
- Per-call timeout 60 seconds. Conservative pre-call cost reservations remain
  counted after errors. Budget capped at $5 across both runs.

The 40 unique request hashes and source record references are in
`manifest.json`; synthetic content and predeclared labels are in
`synthetic.json`. Private evidence and full model responses are stored only
locally under `/tmp/consolidation-model-benchmark-*`, never in this directory.
Historical Jev answers are **not** ground truth.

The database extraction completed at **2026-10-31 11:38:35 UTC**. The manifest's
`cutoff` is the inclusive calendar-window boundary, not a claim to observe the
remainder of 31 October. Later runs and records are outside this dataset.

## Results

| Measurement | Jev 1.14.0 | Decider v1.2 |
| --- | ---: | ---: |
| Synthetic labeled correctness, two repetitions | 48/48 | 48/48 |
| False acceptance of negative synthetic cases | 0/28 exposures | 0/28 exposures |
| Synthetic schema-valid responses | 48/48 | 48/48 |
| Synthetic median latency | 221 ms | 272 ms |
| Synthetic p95 latency | 391 ms | 429 ms |
| Ordinary real schema-valid responses | 12/12 | 12/12 |
| Capacity-stress schema-valid responses | 0/4 | 4/4 |
| Median latency on the same 12 successful real cases | 275 ms | 564 ms |
| Known cost of the same 12 successful real cases | $0.008233218 | $0.003419860 |
| Known cost of all 16 real cases | $0.008233218 | $0.006815320 |
| Unknown-cost real requests | 4 errors | 0 |

Medians average the middle two values for even sample sizes; p95 uses the
nearest-rank method. Matched cost and latency exclude the four Jev failures;
coverage and total cost retain all 16 real cases.

All four Jev capacity failures returned `max_tokens_exceeded`. Decider handled
the same unsplit requests, containing 15–38 questions and 97,327–99,928 JSON
characters. This establishes additional capacity on these inputs, not semantic
correctness of every returned judgment. The corrected Jev application can split
or compact requests; that adapter behavior was deliberately not included in this
common-request comparison.

Total known cost: **$0.016008614**, plus four failed Jev requests for which the
gateway did not report cost. The conservative retained reservation across both
runs is approximately $1.029, below the $5 limit. No provider invoice
reconciliation was performed.

Synthetic boolean Brier scores (20 distinct cases × 2 repetitions) are 0.004095
for Jev and 0.000159 for Decider. These are descriptive scores on a small, mostly
straightforward set; they do not establish calibration in the production domain.

## Independent blind review of real objectives

A separate agent reviewed the four original/proposed page pairs and objective
questions without viewing either model's predictions. Labels were finalized at
11:41:19 UTC, before unblinding. This was a single-reviewer assessment of supplied
evidence, not a human adjudication or external verification of the pages' facts.
Sanitized labels and review scope are in `real-labels.json`; private reasons and
page contents remain local. The objective acceptance threshold is 0.80.

| Case | Blind objective label | Jev probability / decision | Decider probability / decision |
| --- | --- | --- | --- |
| verification-1 | False, high confidence | 0.300 / reject | 0.940 / accept |
| verification-2 | False, medium confidence; disputed, excluded | 0.340 / reject | 0.903 / accept |
| verification-3 | True, high confidence | 0.390 / reject | 0.754 / reject |
| verification-4 | Unknown; excluded | 0.460 / reject | 0.835 / accept |

Case 1 preserves the duplicated claims in a reference sentence instead of
performing the requested centralization: Decider's objective acceptance is a
false positive. Case 3 makes a useful centralization while retaining distinct
context: both models miss it at the declared threshold. Of the two scoreable
cases, Jev gets one correct and Decider zero. **Two cases cannot rank the models**,
but they expose risks hidden by the perfect synthetic score. Cases 2 and 4 need
adjudication; neither contributes to correctness or false-positive counts.

Only the objective question was replayed. A false positive here does not prove
that a damaging edit would pass the separate preservation and integrity gates,
which were not run. The remaining 12 real requests are unlabeled: schema
compliance, disagreement and capacity must not be presented as decision accuracy.

## Interpretation and remaining validation

Keep Jev as the production evaluator for now. Decider warrants further evaluation
because it passed the synthetic safety set, handled all stress inputs, and cost
less on shared successful requests. Jev was faster on that shared set. Decider's
blind-review false positive prevents treating those operational gains as proof
of better decisions.

The real requests are selected for diagnosis, not a random representative
production sample. The verification cohort tests only the objective gate: it
does not run subsequent preservation, provenance or integrity questions, and a
positive objective result does not authorize a write. Before a model change,
freeze a larger independently labeled holdout with both valid and invalid
operations, adjudicate ambiguous labels, and exercise all verification gates
through the corrected application's splitting and compaction paths. Selection
should use false acceptance and missed useful operations, alongside cost,
latency, capacity and data-retention requirements. No thresholds were retuned to
these four observations.

The 16 real cases were each sent once per model after the owner explicitly
authorized both recipients. A request to run two repetitions was rejected by
automatic approval review because it exceeded that specific authorization; the
run was reduced to one. There were no repeated real calls or retries. Stability
of real judgments and holdout performance remain unmeasured.

The live catalog lists Jev with zero data retention and Decider without that
guarantee; both list no-training support. This is a deployment decision to keep
separate from accuracy and capacity.

## Reproduction

From the repository root:

```sh
# Does not read the database or call a model.
node --import tsx scripts/consolidation-model-benchmark.ts --synthetic-only --dry-run

# Rebuilds the combined report from saved results and blind labels; no API calls.
node --import tsx scripts/consolidation-model-benchmark.ts --summarize

# Loads existing server credentials via @next/env. No key is printed.
node --import tsx scripts/consolidation-model-benchmark.ts --synthetic-only \
  --out /tmp/consolidation-model-benchmark-synthetic --repeats 2 --budget 0.2

# Read-only database access; requires an explicitly chosen owner ID.
# Private dataset path is /tmp/consolidation-model-benchmark-private/dataset.json.
node --import tsx scripts/consolidation-model-benchmark.ts --prepare --owner OWNER_ID

# Requires specific authorization to send these private requests to both models.
node --import tsx scripts/consolidation-model-benchmark.ts --real-only \
  --out /tmp/consolidation-model-benchmark-real --repeats 1 --budget 4.9
```

Reports contain model scores but no original page text. Do not commit private
datasets, blind-review evidence or raw responses. The dataset's initial full
fingerprint is `90b8f084c77aab0df15110a41210b6047ec5e30d892c868a7ad7c141dd83cb19`;
each report includes the fingerprint of its filtered cohort.
Exact private replay requires the saved dataset. Preparing it again can select
new records or reconstruct requests differently after changes to analysis code;
compare request hashes before treating it as the same benchmark.

## Current sources

- [AI Gateway decision contract](https://vercel.com/docs/ai-gateway/modalities/decision)
- [AI Gateway live model catalog](https://ai-gateway.vercel.sh/v1/models)
- [Perplexity Decider v1.2 model page](https://vercel.com/ai-gateway/models/pplx-decider-v1.2)
- [TypeSafe System One API](https://docs.typesafe.ai/api/system-one)

Exact IDs checked live: `typesafe-ai/jev-1.14.0` and
`perplexity/pplx-decider-v1.2`. The catalog reported input prices of $0.042/M
and $0.02/M respectively, with zero output-token price. Billed token counts can
differ across providers, so measured cost above uses gateway-reported cost.
