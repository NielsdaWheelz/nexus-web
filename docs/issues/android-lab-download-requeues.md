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
