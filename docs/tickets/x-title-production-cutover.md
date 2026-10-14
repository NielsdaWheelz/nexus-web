# x title production cutover

status: pending release
origin: 2026-10-14 x title implementation
area: release / existing x sources

the implementation and isolated `0277→0278` qualification do not migrate or refresh
production. `deploy/hetzner/deploy.sh:53–63` requires a clean checkout at exact
`origin/main`; the release controller owns stopped writers and a verified backup.
the feature branch is not that release candidate.

prerequisites: merge the qualified candidate, complete existing release gates,
settle unfinished metadata/open media-enrichment generations/active x source work
through their owners, then use the existing controller for the aligned api/worker/web
release. `0278` refuses unresolved work; no downgrade/legacy decoder is available.

freeze other import/metadata admissions while applying the finite census; workers
must run to execute its ordinary jobs. in the released environment:

```sh
python -m nexus.ops.refresh_x_sources plan --manifest /durable/operator/x-titles.json
python -m nexus.ops.refresh_x_sources apply --manifest /durable/operator/x-titles.json
```

repeat `apply` with that same file to confirm receipts and settlement. use ordinary
retry/exact-dead-job repair for refusals, without changing frozen request bytes.
record an issue for each unresolved target/title failure; preserve unavailable copies.
new quote children create title obligations, not new census targets.

acceptance: verify deployed api/web sha and head `0278`; retain backup and frozen
manifest; every target and inline title obligation has a recorded terminal
disposition with zero unfinished/unaccounted work. inspect actual excerpts, titles,
saved-copy recovery and reopened saved positions. delete this item after execution.
