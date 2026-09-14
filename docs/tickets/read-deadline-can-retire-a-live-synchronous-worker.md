# read deadlines can retire a live synchronous worker

- status: open; structural finding, runtime reproduction pending
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
