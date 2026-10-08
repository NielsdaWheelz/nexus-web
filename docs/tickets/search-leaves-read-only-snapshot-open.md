# search() leaves a read-only snapshot open on the caller's session

status: open · origin: 2026-10-04 synapse reauthor (spec D1c, branch cleanup/synapse-reauthor) · area: search

`python/nexus/services/search/service.py:search` rolls back the caller's
session if a transaction is open (discarding any uncommitted writes without a
word) and then calls `get_repeatable_read_db`, which opens REPEATABLE READ and
`SET TRANSACTION READ ONLY` and returns with that transaction still open. the
caller inherits a read-only snapshot it did not ask for.

evidence: synapse D1 (see `retry-serializable-keeps-open-transaction-isolation.md`).
`services/connection_discovery.py:_scan` now ends that snapshot itself with `db.rollback()`
right after retrieval and exclusion; other background callers of `search()`
(tool runtime, dossier inputs) are unaudited.

fix: give `search()` an explicit contract. either it owns and ends its read
transaction (and refuses, rather than discards, a caller's pending writes), or
it documents that it leaves a read-only snapshot open and every background
caller ends it before writing.

acceptance: the contract is written on `search()`, and each non-request caller
is checked against it.
