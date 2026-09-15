status: open
origin: 2026-09-15 restoration release rehearsal, main `c71953c3bd5e851dc742fb967ecedd8c29551e8d`
area: background job failure diagnostics

`python/nexus/jobs/worker.py::_derive_error_code` reads `exc.error_code`,
whereas `python/nexus/errors.py::ApiError` exposes its declared code as
`exc.code`. an ordinary classified api failure therefore becomes
`E_WORKER_HANDLER_FAILED` in the queue record.

production evidence: the sole active generic-web source attempt has a dead
job after three attempts, with that generic queue code and
`last_error = "Fetch failed: fetch failed"`. its retained worker journal at
2026-08-10 03:29:01 utc shows `ApiError` raised by
`web_article_ingest.py::materialize_web_article_source`. this does not prove
the upstream fetch failure's cause or authorize a terminal source failure.

fix: preserve declared api error codes at the queue exception boundary while
retaining the explicit generic code for unclassified exceptions. review the
current child-process error boundary and import-history catalog together;
do not change retry or source-terminalization policy as a diagnostic repair.

acceptance: a narrow deterministic regression proves the declared api code
survives the actual queue failure boundary; an ordinary exception retains the
generic code. run the sole `./scripts/test` contract on the devbox.
