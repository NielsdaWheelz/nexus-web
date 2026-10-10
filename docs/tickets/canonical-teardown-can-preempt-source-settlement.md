# canonical teardown can preempt source settlement

status: open, source-inferred; interleaving not reproduced at runtime.
origin: 2026-10-04 source-acquisition review, base `031c3c95de81f25306b4e17fd656d9eeaf72218c`; independent review `8a97ccc8`, o8, verified by web_map.
area: canonical supersession / source publication phases / media teardown.

`python/nexus/services/media_source_ingest.py:2057-2102` commits supersession,
then applies credits and terminal settlement in separate fenced phases. the
supersession helper calls `delete_duplicate_document_media` (`2314-2355`), which
schedules loser teardown (`media_deletion.py:349`). teardown's two immediate
checkpoints do not wait for the live source execution (`tasks/media_teardown.py:
96-139,142-198`); deletion removes the loser and its attempts
(`media_deletion.py:475-487`). teardown is a light job and source ingest is heavy
(`jobs/registry.py:85-95,263-271`), so their claims can coexist.

arming the intent does NOT itself reject the source fence: it only inserts the
intent/job (`media_deletion.py:96-127`), and the fence checks media, attempt,
latest attempt and exact live queue/capacity claim (`source_publication.py:
63-99`; `jobs/queue.py:469-476,522-541`). if physical deletion commits before a
later phase locks the loser, that phase deterministically raises
`media_identity_changed`; the runner returns `status=superseded` (`1987-1988`).
winner credits, index requests, embed synchronization and terminal settlement
after that boundary are skipped. an x-thread winner carries an actual winner
author observation and additional index targets (`x_ingest.py:135-145`).

bounded reproduction: pause a real claimed canonical source after its
supersession commit, advance that loser's exact teardown job through prepare
and deletion, then release the source. check refused phase, unchanged live
source identity and missing required winner effects. compare source-first and
teardown-first orderings; no provider availability claim is needed.

prerequisite/fix: assign canonical settlement and deletion to their responsible
phase owners. admit loser teardown only after required winner effects and source
terminal settlement have committed, or combine teardown admission with that
final fenced publication. preserve the accepted loser execution identity until
settlement; do not weaken fences or add a general lifetime mechanism.

acceptance: both bounded orderings install required winner credits/index/embed
effects and terminal facts before deletion can preempt them; teardown remains
once-only and owned storage cleanup still runs. admission replay lifetime is a
separate issue: [ticket](canonical-source-teardown-deletes-admission-replay.md).
