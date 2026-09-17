# Production synapse scans repeatedly time out

**Status:** open
**Area:** background jobs / semantic search
**Observed:** 2026-09-11 during production deployment diagnosis

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
