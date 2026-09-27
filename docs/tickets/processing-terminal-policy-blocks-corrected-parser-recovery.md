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
navigation target. `apps/web/src/lib/status/imports.ts:681-682` overstates
the policy as proof that the same source cannot succeed.

first replay the retained exact bytes without publication. add a narrow,
explicit owner-controlled reprocess admission after changed processing
conditions, preserving media identity, original bytes and failure history.
do not relabel historical failures, retry automatically forever, or bypass
archive safety checks. describe current recovery availability truthfully.

acceptance: a diagnosed source can be reprocessed under corrected code;
stale commands cannot overwrite newer attempts; unchanged unsafe input is
still rejected; history identifies the new attempt and its outcome.
