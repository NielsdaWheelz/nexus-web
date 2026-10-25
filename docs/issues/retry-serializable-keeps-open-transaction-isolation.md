# retry transaction contract verification remains open

status: coordinated cutover in progress; runtime verification pending.

`python/nexus/db/retries.py:_attempts` formerly borrowed an already-open
transaction's isolation. its callbacks also owned commit, so a retry could begin
with an unintended snapshot or return after opening another response-read transaction.

both retry flavors now reject ambient transactions before any rollback, establish
the requested isolation, and own commit. their callbacks must retain the same
active transaction, flush and materialize results before return. providers and
other external effects stay outside retries. lock timeout is a neutral database
busy exception; only the api maps it to the existing 409 conflict envelope.

verification must cover the former 63 helper callsites and the 14 consumption
callbacks behind `viewer_txn`, including claim-loss and no-op branches. reader
profile's old commit-then-refresh path is repaired. existing request-session work
must never be discarded merely to satisfy the fresh-entry assertion.

resolve when the coordinated callers pass the static gate and real concurrency
checks prove fresh isolation, whole-attempt rollback/retry, atomic canonical and
search publication, persisted responsive unrelated edits, and typed row-lock
conflicts without repeating external effects.
