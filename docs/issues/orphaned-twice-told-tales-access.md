# twice-told tales has no readable access path

open; access restoration is separate from the accepted book57 data repairs.
the owner explicitly retained this book's unresolved consumer check.

on production `8a67e218ae28cedf89932d7feb13d5cffea05c60`, ordinary
`GET /api/media/781fc83c-3804-4611-9a7a-b475dbacebdf/reader-state`
returned 404. select-only inspection at 2026-10-18 00:42:55 utc found no
library filing or media grant, no viewer tombstone and no teardown. the creator
is the current viewer, but creator metadata alone confers no read permission:
`python/nexus/auth/permissions.py` requires a library-membership or grant path.

its source-proved repair is accepted at publication generation 3, source sha256
`b974fe7a95529a74f39df4c7e3340db5ebd4cfe6c66a3b185dcd22059d46c18f`.
membership and ownership were preserved. there is no passing web/phone claim.
private evidence: `forward-fix-b748a3ace/twice-told-tales-access-paths.json`
and `production49-current-access-census.json`; the other 48 books in that
consumer set remain readable.

resolve by establishing the intended legitimate library filing, then restoring
access through a bounded, source-identity-preserving recovery and verifying an
ordinary owner read. do not weaken permission checks, impersonate a viewer, or
reimport as a new media identity to disguise the orphan.
