# superseded storage deletion has no durable retry

status: open; outside metadata/imports implementation scope
origin: 2026-10-13 source-publication specification review
area: storage cleanup

problem: `python/nexus/services/media_deletion.py:532–549`
`delete_document_storage_objects` deletes already-unreachable paths after commit,
catches `StorageError`, logs `document_storage_delete_failed`, and leaves no retry
obligation. file source replacement calls it from
`python/nexus/services/media_source_adapters.py:440`. an interrupted/failed deletion can
leak an old object; the metadata work does not introduce or repair this behavior.

prerequisite: use the existing storage cleanup owner and preserve live-reference
checks. proposed fix: durably admit cleanup before superseded pointers disappear,
then let that owner retry physical deletion; avoid another garbage-collection system.

acceptance: an injected delete failure or process death leaves recoverable cleanup;
retry eventually deletes the unreachable object and never deletes a live one.
