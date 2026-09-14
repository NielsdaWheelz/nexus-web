# read deadlines can retire a live synchronous worker

- status: open; repair implemented, exact runtime verification pending
- origin: 2026-09-14 bounded-workspace storage-stream review
- area: foreground admission / request lifetime

`python/nexus/api/read_admission.py:113` directly cancels the admitted asyncio
task at its deadline; that task's `finally` removes its permit. the installed
starlette worker adapter awaits anyio's worker future. raw asyncio cancellation
can abandon that future while the synchronous function still runs; anyio's
cancel-scope shielding alone does not establish physical completion.

`python/tests/service/test_read_admission.py:30` proves cancellation of the
outer shielded caller. its deadline case at line 177 blocks asynchronous body
send only. neither observes a deadline during a physical route or storage
iterator step, so the current evidence cannot establish the claimed lifetime.

prerequisite: reproduce with a real held synchronous worker, the existing
one-second deadline profile and request transaction. keep the admission and db
session alive through physical completion, using the existing route/worker
ownership boundary. preserve cancellation of a stalled asynchronous transfer;
do not merely remove deadlines or keep an unbounded waiting queue.

acceptance: after deadline, the held worker still occupies its permit and
transaction; excess work returns capacity and progress remains available. after
physical release, cleanup completes once and the deadline defect is reported.
a stalled asynchronous body send still terminates at the configured deadline.

2026-09-14 implementation: main now uses the reviewed route-owned AnyIO
CancelScope for deadline cancellation, preserving the synchronous-worker shield;
a completed route's own TimeoutError is rethrown. product SHA-256 is
`8fd686b7e4f09a86cd1aeb3b30f918c58429b2662f5bbf476456636ed4ad00e9`.
Exact unfixed source remains at `318747fb5c9bd0763f9db446d0e27a54e18f24de`
with product SHA-256
`4fc04de4c76bcc700be0fd91132e7c3c71b09b554a52a680426e7c7949184935`.

The new held-worker/transaction and child-process timeout tests are in
`python/tests/service/test_read_admission.py` (SHA-256
`16d948e050133adf09c4da59bb16d34f9d2bcbae14f3d97017e95d95af4e5b82`).
The queued reporter/admission invocation stopped before test admission while
upstream CI held the shared lane. No new red or green is claimed. Previous
failures whose primary assertion was lost do not prove held-worker sensitivity.
Pending: controlled exact old-source red with retained pytest phase/type/frame,
then the current full admission owner and canonical cancellation fault replay.
