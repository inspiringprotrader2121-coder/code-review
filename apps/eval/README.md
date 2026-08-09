# Evaluation And Benchmarking

`apps/eval` contains measurement tools, not a production review entrypoint.
No tool may be used to claim a quality change unless its result names the
immutable corpus, model configuration, and normal/manual-review surface.

## Labelled Gold Corpus

`src/cases.ts` is the only labelled corpus. Every case pins the owner/repo,
reviewed PR base SHA and head SHA, and one repository-relative source path and
line from that immutable head. Each witness records whether the historical
review missed the defect, under-rated it, or raised the documented false
positive. The evaluator writes the corpus version, SHA-256 fingerprint, case
count, label counts, model configuration, and request lineage to its result
record. Adding or changing a label or evidence witness is a deliberate corpus
change, not a benchmark rerun.

The primary reported metrics are:

- `normal-surface recall`: positive labels caught in findings production would
  publish normally.
- `normal-surface labelled precision`: negative labels not raised on that same
  normal surface. This is a labelled false-positive check, not a claim that all
  model findings have been exhaustively adjudicated.

Manual-review candidates are reported separately and never added to either
normal-surface metric.

Only an `orvex-labelled-evaluation` record is eligible to describe reviewer
quality. It must carry the canonical corpus fingerprint and both normal-surface
labelled precision and recall. Reversion, severity, competitor, judge, and
diagnostic tools are explicitly non-comparable diagnostics; none may be quoted
as a recall-only or precision-only quality claim.

## Controlled Live Runs

The labelled evaluator, reversion benchmark, precision judge, and diagnostic
funnel make real provider calls only after an operator explicitly sets all of
the following values:

```sh
ORVEX_EVAL_LIVE=1
ORVEX_EVAL_BUDGET_USD=5
ORVEX_EVAL_MAX_CASES=2
ORVEX_EVAL_MAX_REQUESTS=16
ORVEX_EVAL_RESULT_FILE=/absolute/path/to/eval-result.json
```

`ORVEX_EVAL_BUDGET_USD` records the approved spend ceiling. Vendor token
pricing is not predictable enough for local code to enforce a dollar amount, so
`ORVEX_EVAL_MAX_REQUESTS` is the hard technical ceiling and the run refuses to
start another request after it. Results are written with exclusive creation and
therefore cannot overwrite an earlier record.

Example, after explicit approval:

```sh
ORVEX_EVAL_LIVE=1 ORVEX_EVAL_BUDGET_USD=5 ORVEX_EVAL_MAX_CASES=1 \
ORVEX_EVAL_MAX_REQUESTS=8 ORVEX_EVAL_RESULT_FILE=/tmp/orvex-eval.json \
pnpm --filter @orvex-review/eval eval one-case-name
```

The controlled-live replay uses a direct Responses API call for the Luna stage,
not the production containerized Codex CLI. Every resulting record is labelled
`non-production-transport` and is ineligible for a production quality claim.
It remains a controlled diagnostic of the labelled normal/manual partition and
the model configuration it records; it does not measure Codex CLI exploration,
sandbox behavior, or the shipped high-tier execution path.

## Competitor Snapshots

`src/bench/competitors.ts` emits schema-version 2 snapshots only. A comparable
snapshot uses strict confirmed-Orvex-table parsing and labels anchored inline
comparison as its headline. The combiner rejects any snapshot missing those
properties. Competitor coverage is a diagnostic source for hand labelling, not
precision or recall evidence by itself.

See [the quarantine ledger](src/bench/results/QUARANTINED.md) before citing a
historical competitor result.
