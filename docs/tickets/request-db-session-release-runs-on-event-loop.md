# request session release runs on the api event loop

status: open · origin: 2026-09-21 chat-database repair probe, main `8d6a9209b5` · area: api substrate / db session

`python/nexus/middleware/db_session.py:21-36` calls
`release_tracked_request_db_sessions` from the async `send_wrapper` at
`http.response.start` and again in `finally`. `python/nexus/db/session.py:79-89`
then runs `db.rollback()` (a network round trip when a transaction is open)
and `db.close()` (pool return with reset-on-return) synchronously on the event
loop for every request that took `get_db`.

evidence: the controlled probe receipt
`/tmp/nexus-chat-database-probe-baseline.json` records `close` on
`MainThread` for every baseline request; the chat routes no longer take
`get_db` after cleanup/chat-database, every other `get_db` route still does.

impact: one database round trip on the loop per request; a stalled database at
response start stalls every in-flight response in the api process.
source-confirmed; no live stall induced.

prerequisites: keep release-at-response-start semantics so connections are
not pinned across body transfer.

proposed fix: in the api-substrate reauthoring, hand the release to
`run_in_threadpool` inside `send_wrapper`, or move routes to phase-owned
sessions (as chat now does) so no request-scoped session remains to release.

acceptance: a probe that blocks `Session.close` shows an unrelated coroutine
advancing while a response starts; `./scripts/test` passes.
