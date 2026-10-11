# import history reads an embedding provider outage as a handler failure

status: open · origin: 2026-10-10 jobs runtime reauthor (coordinator R4) · area: imports / import history

a media reindex attempt whose embedding provider stayed unavailable now records
`E_EMBEDDING_PROVIDER_UNAVAILABLE` on `background_jobs.error_code` (an `ApiError`
from `services/content_chunking.plan_chunks`), and a dead note index reads
`"E_EMBEDDING_PROVIDER_UNAVAILABLE: ..."`. import history still names the
attempt `E_WORKER_HANDLER_FAILED` ("Processing failed"): the code is not in the
`SafeFailureCode` catalog (`schemas/import_history.py`), so the total
`queue_failure_code` maps it there. the copy ("nothing about the source caused
this") is true but loses the cause.

proposed fix: add the code to `_OWNER_FAILURE_CODES`, regenerate the wire, and word
it in `apps/web/src/lib/imports/copy.ts` (retry: SameSource).

acceptance: a reindex that dies on a held-down embedding provider shows the
provider cause in the import inspector.
