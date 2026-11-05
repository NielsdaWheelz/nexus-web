# chat admission exhausts its serializable retry

a quoted send can return 409 `E_RESOURCE_CONFLICT` (`Resource is busy; try again`)
while the account's source jobs settle. the immutable command must be retried with
the same bytes and idempotency key; increasing the server budget is not a fix.

evidence: disposable run `20261105-055240-5d53a6dd298a`, request
`eac0ea90-8be3-4705-bbbe-6e8456878dc2`. `chat/admit.py:_settle` exhausted three
serializable attempts while `_start_run` inserted into `background_jobs`
(`chat/admit.py:549`, `jobs/queue.py:141`). postgres reported read/write pivot
cancellation at 13:53:55.512, 13:53:57.826 and 13:54:00.143 utc. content reindex and
failed x-quote jobs were settling concurrently. preview validation succeeded;
there was no evidence-schema failure. exact dependency edges were not captured.

inspect and narrow the participating reads/writes at their owners; do not infer
production frequency from a tiny disposable database. related ingest observations:
[lone acquisition](lone-acquisition-exhausts-serializable-retry.md).

resolved when normal quoted sends remain available during those settlements, with
one accepted command/run per key and no stranded admission after cancellation or
explicit retry. retain the existing client retry contract.
