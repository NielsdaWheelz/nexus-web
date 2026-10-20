# retry_serializable silently keeps an open transaction's isolation

status: open · origin: 2026-10-04 synapse reauthor (spec D1b, branch cleanup/synapse-reauthor) · area: db / transactions

`python/nexus/db/retries.py:_attempts` selects an attempt's isolation only
when `not db.in_transaction()`. so a caller that arrives at
`retry_serializable` (or `retry_read_committed`) with a transaction already
open runs its first attempt at whatever isolation that transaction has,
including a read-only REPEATABLE READ snapshot. the module docstring says so;
nothing refuses it. (every refusal now rolls the attempt back, so a refused
attempt no longer leaves its transaction open for the next one: the db
substrate re-slice fixed that half.)

evidence: the synapse D1 defect. `search()` leaves REPEATABLE READ READ ONLY
open on the caller's session; the old scan then published through
`retry_serializable`, which no-oped the isolation, and the lease-fenced
`SELECT … FOR UPDATE` raised `ReadOnlySqlTransaction` on every empty-candidate
scan (harness baseline 2026-10-04, `baseline.txt` D1). the rewrite fixes the
synapse caller by rolling back first; every other caller is still exposed.

a second caller (2026-10-20 python auth re-slice, spec L10): the extension
viewer ran `ensure_user_and_default_library` inside the request session after
`resolve_extension_session_user` had flushed `last_used_at`, so its retry ran at
READ COMMITTED and its commit was what persisted `last_used_at` (the request
session rolls back on release). the slice removed that call (the extension
viewer resolves identity only and the lookup commits its own touch); the
helper's silent downgrade is the db slice's (no `python/nexus/db` file changes
outside it).

prerequisite: a census that reaches the routes the harness does not drive.
the one below covers the harness journeys' paths only. a route that reads
before calling a service enters with an autobegun transaction, and static
reading cannot list such routes, so refusing now could turn an untested route
into a 500 (db substrate design Q10 (b): keep the silent keep, census first).

census (2026-10-20, db substrate harness journey E-1: every retry helper call of a full
platform cycle, api and both worker lanes, logged with `db.in_transaction()` at entry; the
same 47 labels on base `f2025d935` and the re-slice, 1,552-2,738 calls per run, the spread all
in time-bounded place/unplace and lectern loops): before the python auth re-slice (#710) one
label entered with a transaction open, `default_library_bootstrap` from the extension viewer,
the second caller above (6 calls per run). #710 removed that call, and the one bootstrap
caller left, `auth/middleware.py:_bootstrap`, opens its own session. E-1 rerun on main
`d1ed4907f` (2,230 and 2,128 calls) and on the re-slice ported onto it (2,142): the same 47
labels, none entered with a transaction open. so after #710 no known caller enters a retry
helper with a transaction open. the census is the journeys' paths, not every caller, so the
issue stays open.

fix: make entry with an open transaction a defect (`assert not
db.in_transaction()` or a typed error) at the responsible layer, after the
census repairs the callers that rely on the silent downgrade.

acceptance: `retry_serializable` refuses an open transaction, and the census
shows no caller hitting it on the harness journeys of the slices it covers.
