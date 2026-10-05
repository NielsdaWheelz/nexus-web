# library filing invalidates every viewer's inventories

status: open · origin: 2026-10-04 cleanup/linear-02 spec review · area: library filing / collection revisions

one media filing locks the actor's default/selected libraries, then advances four
inventory families for every account. unrelated viewers therefore share revision
write contention; the write set grows with account count rather than affected
visibility. the current coarse invalidation may be correct, but its cost and
transaction coupling need an explicit owner.

evidence at `557aed14f1d88bdb2b1bc9856944ce433e38f115`:
`python/nexus/services/library_entries.py:890,895` locks libraries and calls
`_bump_entry_visibility_revisions:80–82`.
`library_governance.py:161–170` uses `FOR UPDATE`;
`collection_revisions.py:27–32,93–105` advances author works, library entries,
podcast episodes and podcast subscriptions from an unfiltered `User.id` select.
the fanout is source-qualified; its natural failure contribution and latency
have not been measured.

current cleanup qualification blocked a separate candidate-only regression:
source `1f7d100c0acbf8d7e5fa3d5b7a75e6f008772447ccf7d52bc979b2fc17d566e8`
wrapped this filing path in serializable admission. twenty distinct generic URL
requests at concurrency two to one destination returned sixteen 202 and four
500 in 0.397174 seconds. all four failures exhausted the unchanged three-attempt
budget at `library_entries.ensure_entry:386` (`INSERT INTO library_entries`),
with no retained media, attempt, job, history or filing. the sixteen successes
each committed one media/attempt/job/history and default plus named filing.
the exact task-postgres window `2026-10-05T01:24:45.126627+00:00` inclusive to
`01:24:45.523801+00:00` exclusive contains sixteen natural serialization errors,
with no fault injection. logged `psycopg.errors.SerializationFailure` identifies
SQLSTATE `40001`. `ensure_entry:372–384` documents a read-committed library-row
lock / next-position contract; this candidate violated it. the trace does not
establish global revision fanout as the failing statement or reproduce a
pre-existing natural failure.

receipt: `/tmp/nexus-linear-02-20261004/failed-serializable-1f7d100c/failure-qualification.json`
(sha256 `155a3375854760cfdd55a472c79b9ef10bb433d1b1a437d5ac760aa94b1e0b34`).
workers were stopped; no provider or extraction work ran. no unchanged burst
rerun was used. the current change must honor the filing isolation contract;
the independent all-viewer fanout remains open.

prerequisite: identify each inventory family's actual affected viewers,
including shared-library and podcast visibility. scope revision updates to that
authoritative set while preserving invalidation; keep library reference locks
owned by filing. no speculative retry budget, backoff or timing workaround.

acceptance: affected readers observe the updated inventories, unrelated viewers'
revisions remain unchanged, and concurrent ordinary filing is qualified against
real database contention with exact request/error receipts.
