# Production synapse scans repeatedly time out

**Status:** open
**Area:** background jobs / semantic search
**Observed:** 2026-09-11 during production deployment diagnosis

2026-10-13 recurrence on production `3ea1b8e6e` / `0276`: the new
`connection_discovery_scan` job `96a1d707-e367-454f-bc63-5f8fce2ab0f9` died
after its third attempt at 19:00:08.999595 utc with
`psycopg.errors.QueryCanceled: canceling statement due to statement timeout`.
the bounded error names the visibility query over
highlights, library entries, media, memberships and resource grants; no native
provider failure has been established. private release receipt:
`nexus-release-20261013/discovery-job-final-state.json`, read at
19:17:47.117459 utc. its 1,000-byte error has the same sha256 as the second
attempt: `ab2dcfbc351810fe9aa792f3028ad50a312e9507a4adbbecd4281dc61397004e`.
the source is one of the two deliberately readmitted note owners; neither its
contents nor a reconstructed query has been replayed on production.
the previous backlog's retirement therefore did not resolve the query cost.

the restored `0276` database isolates an avoidable full-index path in
`services/search/sources.py:362`: the candidate-id `IN (lexical UNION ALL ann)`
filter runs after joins over 711,794 chunks and 711,814 evidence spans. the
direct equivalent text-or-id predicate uses the existing gin/primary-key
bitmap filters first and performs only 49 evidence-span lookups for this page.
ordered row/score hashes match for the exact note's lexical query
(18.23 s → 1.31 s), 200-id semantic-only control (15.91 s → 0.10 s), and mixed
control (17.74 s → 1.29 s). hidden and missing candidates remain excluded;
temporary spill falls from 20,170 blocks to zero. independent source review
confirmed unchanged visibility, scope, readiness, scoring, order and limits.
private receipts: `2026-10-13/release/runtime-query-audit/` in campaign artifacts.
this qualifies the database predicate change; a deployed scan retry and the
observation window below remain required. no provider call or heavy production
query was used for this diagnosis.

Production release `7e8fd48244b3b436965037738e05785bb4931be1` emitted 146
`synapse_scan_failed_unexpected` events from `nexus-worker-background-1` in the
24 hours ending 2026-09-11. The failures wrap PostgreSQL statement timeouts.
The same inspection found 33 pending and one running `synapse_scan` job, so the
optional scan queue is consuming the background lane without converging.

First deploy the already-reviewed search and generation cutovers on current
`main`; they substantially replace this execution path. Then observe a bounded
post-deployment interval and inspect only aggregate job state and typed errors.
If timeouts continue, profile the exact candidate-owned query plan against a
redacted production-shape input, bound candidate retrieval before enrichment,
and manually measure query cost and retry convergence.

This issue is resolved only when a deployed release completes or terminally
classifies the inherited backlog, no new unexpected statement-timeout failures
occur during the observation window, and ordinary background jobs continue to
make progress within their published latency bound.

## 2026-09-15 recurrence

After the user repaired a stalled web import on production `a1f59a755c`, source
recovery succeeded at 06:53:11 utc. Its ordinary follow-up scan again failed
twice with `psycopg.errors.QueryCanceled: canceling statement due to statement
timeout` in the `WITH visible_media` query. No nonterminal model call remained.
The shared visibility query is byte-identical in restored `f75a7aa0d77a`.
Restored search does limit ranking before expensive snippets and contributor
enrichment, but the observed sql prefix does not identify the failing retriever.
This is a relevant mitigation, not proof of resolution. No production queue
rows were changed. Keep this item open through the post-release observation.

## 2026-10-04 synapse reauthor

The rewrite removes one source of churn on this queue: a scan whose candidate
set was empty used to raise `ReadOnlySqlTransaction` three times (60/300/900 s)
and dead-letter, holding a background slot each time (harness baseline: four
such jobs per fresh stack before any journey). It now ends its read snapshot
and publishes the empty set as `ok`. Migration `0260` drops unfinished scans
that a previous release admitted. Neither is proof against statement timeouts;
the post-deployment observation above remains the acceptance.
