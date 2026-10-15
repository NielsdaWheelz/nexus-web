# terminal source policy blocks recovery after parser corrections

status: open
origin: 2026-09-26 processing-failure investigation
area: source recovery / imports

production `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`, database `0241`,
read at 2026-09-27 00:32 utc: 15 of 25 failed source imports carry codes in
the same-source terminal set. this includes pierre
`13c1fae1-70cd-4438-bf0d-203fb7e376a3` (missing navigation anchor) and portrait
`9e5d8118-050d-48dc-9c99-870443481f61` (historical 30-second parse limit).
`services/capabilities.py:53-63` and `services/media_source_ingest.py:245-255`
deny recovery by old error code; the latter's system repair also refuses it.
current `services/epub_structure.py:100-103` already tolerates an unresolved
navigation target. `apps/web/src/lib/imports/copy.ts` (`RESTRICTION_LINE.SameSourceTerminal`) overstates
the policy as proof that the same source cannot succeed.

the 2026-10-15 cleanup cutover at `43433c845d7b51d94ece4ffcb83db2434735a23d`
deleted `python/nexus/ops/processing_recovery.py` and its source reprocess
admission. the prepared portrait command for `0bd661923` remains unrun and
cannot be rebound by changing its runtime hash. the retained clone baseline
records latest attempt `807a52d2-8c01-45fb-abd2-59cac6aea40e` as failed,
`uploaded_epub_file`, `E_ARCHIVE_UNSAFE`, with no job. the recorded reason is
the old 58,836 ms / 30,000 ms parse limit; no current migrated-row observation
has been made.

at this cutover, `python/nexus/services/source_attempts.py:200-247` still
classifies these exact facts as `SameSourceTerminal`.
`services/media_source_ingest.py:632-671` requires a normal retry offer;
`repair_source` at lines 715-754 repairs an in-flight dead job, which this
historical failed attempt is not. normal retry now replays the deterministic
successor of the expected attempt, rather than an operator mutation receipt.
its public request has no expected-source-hash field. the file-only audit
`c-sources/portrait-434-contract-audit-v1.json` (`02e82453ea527b1734a9669f63cbe9af9144879f672989354d8f6294df50fe61`)
binds the source files and historical baseline and reproduces the restriction
through the actual pure policy function. it makes no database or source call.

first replay the retained exact bytes without publication. add a narrow,
explicit owner-controlled reprocess admission after changed processing
conditions, preserving media identity, original bytes and failure history.
do not relabel historical failures, retry automatically forever, or bypass
archive safety checks. use the current source-attempt/successor owner and
ordinary worker; do not revive the deleted operator module or its replay
protocol. describe current recovery availability truthfully. a current target
census, exact source binding and fresh clone qualification precede execution.

acceptance: a diagnosed source can be reprocessed under corrected code;
stale commands cannot overwrite newer attempts; unchanged unsafe input is
still rejected; history identifies the new attempt and its outcome.
