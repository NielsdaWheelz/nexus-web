# android lab reading copies requeue after interruption

in three disposable android 35 labs, one of two requested reading copies remained
queued after a retryable interruption for at least 90 seconds. this blocked those
shelf qualification attempts. the cause and
production impact are unknown.

evidence: labs `20261028-200135-07aa3b6a5c8f` (second copy) and
`20261028-201923-f791d59bc4d4` (first copy), and
`20261028-203021-83cc2c784348` (first copy), each in
`artifacts/playwright/recent-native-shelf-downloaded-shelf-open-becomes-recent/error-context.md`.
both copies completed on a fresh owned avd in `20261028-205116-98984ad72240`;
that qualifies the recent journey but does not establish this failure's cause.
reproduce with two
real article downloads on an owned emulator, inspect the job stop reason and
transfer failure, and resolve when queued copies complete or report an actionable
failure without stalling.

run `20261028-213644-490ad0adf70b` narrowed the failure: transfer job
`1314407500` called `jobFinished` after 226 ms and rescheduled with one failure;
there was no os stop reason. `OfflineJobService.kt:304-306` converts its
`IOException` into retryable network failure without retaining the cause. the api
logged no reading-copy access entry; that does not prove the request never arrived.
diagnose that exception before changing retry or scheduling policy.

the canonical integrated shelf journey passed in `20261028-220347-9526792e2a09`:
its first copy completed after 134,963 ms through normal retry, the second after
842 ms. offline restart and supersession passed. this qualifies recency and
reader composition but does not resolve the intermittent transfer failure.
