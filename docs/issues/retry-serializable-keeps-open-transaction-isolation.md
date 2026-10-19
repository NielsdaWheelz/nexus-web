# retry_serializable silently keeps an open transaction's isolation

status: open · origin: 2026-10-04 synapse reauthor (spec D1b, branch cleanup/synapse-reauthor) · area: db / transactions

`python/nexus/db/session.py:use_serializable` sets SERIALIZABLE only when
`not db.in_transaction()`. `retry_serializable` (`db/retries.py:109`) calls it
before each attempt, so a caller that arrives with a transaction already open
runs its "serializable" attempt at whatever isolation that transaction has,
including a read-only REPEATABLE READ snapshot. nothing says so.

evidence: the synapse D1 defect. `search()` leaves REPEATABLE READ READ ONLY
open on the caller's session; the old scan then published through
`retry_serializable`, which no-oped the isolation, and the lease-fenced
`SELECT … FOR UPDATE` raised `ReadOnlySqlTransaction` on every empty-candidate
scan (harness baseline 2026-10-04, `baseline.txt` D1). the rewrite fixes the
synapse caller by rolling back first; every other caller is still exposed.

prerequisite: a census of `retry_serializable`, `admit_serializable` and
`use_serializable` callers that may enter with a transaction open (the static
gate cannot find them; there is no test suite).

fix: make entry with an open transaction a defect (`assert not
db.in_transaction()` or a typed error) at the responsible layer, after the
census repairs the callers that rely on the silent downgrade.

acceptance: `retry_serializable` refuses an open transaction, and the census
shows no caller hitting it on the harness journeys of the slices it covers.
