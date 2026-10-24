# failed media projections have no ordinary retry

status: open
origin: 2026-10-13 live qualification (#578)
area: media intelligence / connection discovery

a media summary that fails during a generation outage has no direct product
recovery action. dossier removal deletes that former consumer; connection
discovery still needs the shared summary and grounded claims.

evidence: `services/media_intelligence.py:get_media_unit` reports failed heads;
`services/connection_discovery.py:_source_context` skips a media source on any
`NotReady` result. `services/media_intelligence_lifecycle.py:ensure_media_unit_in_tx`
can rebuild a failed head when indexing calls it, but no ordinary action admits
just that recovery. historical live proof recorded a failed summary with
`error_code=runtime_unavailable` and a succeeded `media_unit_build` job; this
remaining discovery impact has not been reproduced live in the removal change.

preserve one-job-per-content-version and generation charging guarantees. admit
an explicit recovery through the existing summary owner and normal product
action; do not repair publication through fixture/database writes.

resolved when a genuine failure, restored provider and ordinary recovery produce
a ready summary and usable discovery for the same media. repeated recovery must
not create duplicate active work.
