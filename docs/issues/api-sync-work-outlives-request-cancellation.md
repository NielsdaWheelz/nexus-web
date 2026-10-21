# synchronous api work can outlive request cancellation

status: open · origin: 2026-10-13 production release and restored-copy shutdown control · area: api / database / lifecycle

on source `16763c3cd4a7cb0b54520e99ec388fb82d573b9d`, an actual
`GET /lectern/suggestions` remained active after uvicorn's proposed 20-second
grace cancelled the asgi task. the metadata stream and lifespan closed at
20.14 seconds, but the synchronous worker survived until docker killed the
process at 30.23 seconds (exit 137, no oom). one active database session was
still visible immediately after the kill and subsequently disappeared.

`python/nexus/db/session.py:get_db` owns the dependency; its shielded rollback
and close (`_release`) can wait for a psycopg query already running in another
thread. cancelling the asgi task neither stops that thread nor prevents its
later statements. calling rollback or close from a second owner is not a
safe cancellation protocol.

private receipt: `release/api-shutdown-qualification/timeout-only-failed/`;
receipt sha256 `ca95797c2cd6cde2e71217a7aefec061ba70088193442bd185e3b934418ac797`.
the measured similarity-query repair and finite-request/stream shutdown
control qualify that release workload; they do not establish a bound for
every synchronous request. the deployer's nonzero-exit refusal remains in
force.

browser search now owns native async provider/database work, one session and
aggregate disconnect/deadline cancellation in `api/routes/search.py::_run`.
controlled disconnects terminate the exact observed postgres backend and close
the actual in-flight provider client; the operation joins its tasks. this fixes
that read boundary, not the synchronous suggestions/write/sigterm paths described
here. search's contract lives in [the search module](../modules/search.md).

fix: define cancellation ownership across the request, synchronous handler
and database session before changing cleanup. preserve one session owner,
transaction atomicity and honest uncertain-commit handling. do not treat an
asgi cancellation acknowledgement as proof that database work stopped.

acceptance: a controlled active read and a transactional write crossing
request cancellation and sigterm leave no executing query, later statement,
session ownership race or ambiguous success claim; process cleanup finishes
inside the configured container grace. retain ordinary successful-request
and persistent-stream controls.
