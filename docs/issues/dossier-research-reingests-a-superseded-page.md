# dossier research ingests a superseded page a second time

**problem**: `services/dossier/research.py` `_page` calls `accept_url_source` with its fixed
id (`uuid5(NAMESPACE_URL, "dossier:<key>")`) on every recheck, and only then asks
`superseding_media_id`. when the page's first ingest converged on a document the reader
already has, the run supersedes onto that winner and claims its own media for teardown; the
teardown deletes the media's attempts, so the next recheck's `accept_url_source` finds no
attempt with that id and accepts the page again: a second media, a second
`ingest_media_source` job, a second fetch. the second run supersedes onto the same winner
(`record_supersession` keeps the first answer), so the dossier still resolves correctly.
the base code behaved the same (its lookup read rehomed history rows); the imports slice
moved the identity to `media_source_supersessions` without changing this order.

**impact**: one wasted fetch, extraction and teardown per superseded research page, and a
transient extra media row; no wrong output.

**evidence**: harness journey H-SUP (`2026-10-15/imports/harness`) reports the research
attempt's `ingest_media_source` jobs without asserting them: two (ten seconds apart, on two
media) in the explore run and tip-1, one in tip-2 to tip-5. the second accept happens only
when a recheck lands after the loser's teardown, so the count is timing, not the fix.
`media_source_supersessions` holds one row for the attempt in every run.

**resolved when**: with the supersession committed and the loser torn down, a forced second
`_page` call for the same key returns the winner without accepting again (the deadline needs
a time that survives the teardown, e.g. the supersession row's own `created_at`), and H-SUP
forces that recheck and asserts exactly one ingest job for the research attempt.
