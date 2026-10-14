# `normalize_stored_web_publication` has no caller

status: open (found by the ingest reauthor, 2026-10-14).
area: reader publication (`python/nexus/services/reader_publication.py`).

problem: the ingest reauthor deleted `python/nexus/ops/processing_recovery.py`
(release repair tooling, decision Q8), the only caller of
`reader_publication.normalize_stored_web_publication` (~100 lines). the function
and its `E_REPAIR_NOT_ALLOWED` refusals are now dead code in the reader's file.

impact: none at runtime; a reader of the module meets a repair path nothing runs.

evidence: `git grep normalize_stored_web_publication` names only its definition.

resolved when: the reader python slice (which owns the file and waits for the
post-release purge) deletes it, or gives it a caller.
