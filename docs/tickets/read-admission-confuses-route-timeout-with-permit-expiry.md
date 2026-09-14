status: open
origin: 2026-09-14 admission deadline review during native classifier repair
area: api read admission failure classification

`python/nexus/api/read_admission.py:110` catches `TimeoutError` from
`asyncio.wait_for(asyncio.shield(task), ...)` without distinguishing an expired
wait from the admitted route's own `TimeoutError`. a completed route failure
therefore sets `expired` and attempts cancellation instead of preserving the
original defect; on the next iteration the completed task raises the same error.
this is source-level evidence, not an executed regression.

preserve the completed task's original exception before classifying a waiting
deadline (or let one task-owned cancel scope own the deadline directly). do not
add another timeout/failure registry. the current deadline lifetime repair must
still retain physical synchronous work and cancel an async stalled send.

acceptance: an actual admitted route raising a distinct `TimeoutError` completes
with that original error and releases its permit; it cannot spin or become a
permit-deadline refusal. true permit expiry retains its separate lifetime oracle.
