# lectern writes answer 500 beside concurrent commits

status: open
origin: 2026-10-18 libs2 harness baseline (HA4); diagnosed 2026-10-19 in the
libraries + ordering re-slice (coordinator ruling R5)
area: consumption transactions / lectern / suggestions input revision

problem: a lectern write (`services/consumption/lectern.py` place, remove, move)
runs in `viewer_txn` (`services/consumption/__init__.py`): a SERIALIZABLE attempt
whose first statement is the viewer row lock, retried three times. the
snapshot is taken when that first statement starts, before the lock is granted,
so a concurrent commit that updated a row the attempt then touches fails it with
`40001 could not serialize access due to concurrent update`:

- the viewer row itself: every lectern write advances
  `users.lectern_order_revision`, so two writes by one viewer collide at the
  lock statement (`SELECT 1 FROM users WHERE id = :id FOR UPDATE`).
- `suggestion_inputs` (the one counter every source owner bumps last): any
  concurrent source commit collides with the attempt's final bump.
- `media` rows: since #671, `library_entries.lock_media_for_reference` rewrites
  the media tuple, so the lectern insert's foreign-key check (`FOR KEY SHARE` on
  `media`) collides with a concurrent filing of that media.

three collisions in a row exhaust the budget and the route answers 500
`E_INTERNAL` (`DatabaseRetryExhaustedError lectern_place|lectern_remove`).

evidence (`nexus-web-campaign-artifacts/2026-10-18/libs2/harness`, journey HA4: 4
lectern writers for one viewer + 8 filers on the same 4 media, 30 s):
- 140d58163: 219 and 169 lectern 500s (file 204: 6,615 and 5,610).
- d6b73c712 (`runs/baseline-d6b.api.log`): 12 lectern 500s; the exhausting
  attempts failed at the viewer lock (9), at the media foreign-key check (2) and
  in a deadlock (1); filing fell to 143 in 30 s and 2 filings died in deadlocks
  (`place_item`) through the media rows the lectern attempts key-share.

- the re-slice (same transactions and server paths): lectern 500s per lectern
  write 9.8-10.9 % in three d6b73c712 runs (12-22 500s); 5.7-11.2 % in five runs
  of the re-slice, plus 22.8 % (a run with under 5 GiB free on the host), 20.4 %
  and 17.9 % (12-39 500s across all eight).
- against main 0c6da7f32, three interleaved main/re-slice pairs of HA4 alone
  (`runs/fix-ha4-{main,tip}-{1,2,3}.txt`; the other harness slot busy, load
  9-33): main 20, 1 and 9 lectern 500s (30.3 %, 1.2 %, 19.6 % of 66, 80 and 46
  writes), the re-slice 10, 11 and 9 (7.1 %, 7.5 %, 7.1 % of 140, 146 and 127).
  main's own spread covers the re-slice's earlier tail, so on this evidence the
  tail is host load, not the slice. the re-slice also ran about twice main's
  writes and filings in every pair; HA4's request paths are the same code on
  both, and that difference is not explained.
- the failing statement of each exhausted attempt (the SQL in its traceback's
  cause), summed over the api logs: d6b73c712 and main, 6 runs, 78 attempts:
  the viewer lock 48, the counter 15, the lectern row insert (its media
  foreign-key check) 15; the re-slice, 18 runs, 310: 187, 88, 35. in HA4-only
  cycles the counter's share is alike (main 15 of 66, the re-slice 9 of 60); it
  is larger in some full cycles (20 of 39, 13 of 29).

the counter is suggestions' own, and a counter that never conflicts under
SERIALIZABLE (an append-only or sequence-backed revision whose readers still see
every committed change) is a schema change in suggestions alone. it was not made
here: the viewer lock fails attempts in every run, so fixing the counter by
itself would not flip HA4. it is owed regardless: it has a second victim the
viewer lock does not explain. concurrent page creates exhaust their retry on
the same counter with no viewer lock involved
([concurrent-page-create-exhausts-input-invalidation-retry](concurrent-page-create-exhausts-input-invalidation-retry.md),
from #683), so the counter half of the fix below serves both issues.

proposed fix (consumption core): stop fixing the snapshot before the viewer lock
is held, e.g. run lectern writes read-committed under the viewer lock, which
already serializes one viewer's lectern; then give the input revision a
non-conflicting representation in its own migration, and re-measure the media
foreign-key collision after #671's tuple touch.

resolved when: HA4 passes twice (no 5xx, lecterns dense) on the harness.
