# concurrent daily captures to one page exhaust their retry

status: open · origin: 2026-10-20 db substrate harness (`RET.concurrent-daily-captures`) · area: notes / daily page

eight concurrent `POST /notes/daily/{date}/captures` to one day's page: about
two in three answer 500 `E_INTERNAL`. each capture runs under
`retry_serializable(db, "daily_capture", op)`
(`python/nexus/services/notes.py:283`; since the notes re-slice one
`ensure_daily` + `insert_note` batch) and bumps the page's links-lane
`resource_versions` row; concurrent captures collide there on all three
attempts and raise `DatabaseRetryExhaustedError`.

impact: quick-note captures fired close together (several devices, a burst of
shares) lose notes with a 500; the client's resend with the same note id may
land later. the same counter shape as
[concurrent page creates](concurrent-page-create-exhausts-input-invalidation-retry.md)
and [lectern writes](lectern-writes-fail-under-concurrent-commits.md).

evidence: harness runs `2026-10-20/db/harness/runs/baseline-*.txt`: two rounds
of 8 -> `{"200":6,"500":10}` on `4428634e8`, `{"200":5,"500":11}` on
`f2025d935`; the api log names `daily_capture exhausted after 3 transaction
attempts`.

fix: take the page's links-lane row lock (`SELECT … FOR UPDATE`) before the
serializable read, or bump the version under READ COMMITTED with a lock, so
concurrent captures queue instead of failing; then the bound is lock wait, not
attempts.

resolved when: the harness journey's concurrent captures all answer 200 and
every note is stored.
