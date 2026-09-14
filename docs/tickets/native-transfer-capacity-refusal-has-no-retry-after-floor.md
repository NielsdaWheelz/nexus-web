# a server capacity refusal does not honour its Retry-After on the native transfer

- status: open; reviewed durable-floor implementation integrated, verification pending
- origin: 2026-09-14 adversarial review of the bounded-workspace implementation
- area: native offline reading / transfer scheduling

## what is wrong

a `503 E_READ_CAPACITY` from the admitted package-transfer route is now a
first-class outcome rather than a failure: `offlineReadingRefusal(status,
errorCode)` returns `Fail(reason)` or `Capacity`, `requireSuccess` throws
`OfflineReadingCapacityRefusedException`, `asOfflineReadingOriginException`
rethrows it unchanged so it cannot be laundered into a failure, and
`OfflineReadingTransferJobService` catches it into
`ReadingTransferState.Queued(ReadingQueueReason.ServerCapacity)` +
`TransferStep.DeferUntilUnlocked` — the same delayed-retry shape a locked binding
key already uses, so JobScheduler's exponential backoff owns the next attempt and
the staged bytes survive.

the reviewed correction persists the parsed floor separately from queue reason,
because policy changes rewrite that reason. claims enforce eligibility and idle
checkpoints retain os retry demand. reopen cleanup now preserves exact archive
and verified names owned by nonfailed transfers; previously it deleted those
queued bytes. migration, real-http refusal and store/checkpoint proofs are added.
their current-source and sensitivity runs remain required before closure; a
physical scheduler execution is not claimed from host proof.

peer review also requires the actual job-service catch to be exercised: changing
its forwarded `refusal.retryNotBefore` to null would evade the current separate
http and store proofs. the existing signed-promotion enqueue reaches the real
job service, but no host harness currently delivers that platform job. this
composition remains source-reviewed and runtime-unverified under the user's
physical-handset waiver. preserve the real service boundary when exercising it
on a device; do not add owned-state injection or a test-only product seam.

what is **not** honoured is the server's `Retry-After`. JobScheduler's backoff is
configured once in `OfflineReadingScheduler.buildJob` (`setBackoffCriteria`,
`DEFAULT_INITIAL_BACKOFF_MILLIS` / `EXPONENTIAL`), so the device retries on its
own schedule and can return before the server is ready.

## prerequisites

preserve the existing user-initiated transfer contract. adding
`setMinimumLatency` to its replacement `JobInfo` is invalid: android rejects
user-initiated jobs with a time delay. background rescheduling also has
foreground-admission restrictions. see the [android job contract](https://android.googlesource.com/platform/prebuilts/fullsdk/sources/+/refs/heads/androidx-constraintlayout-release/android-35/android/app/job/JobInfo.java#2447).

## proposed fix

parse `Retry-After` at the refusal and carry its deadline into the existing
durable transfer state. check eligibility before another server request; keep
staged bytes and the existing os retry owner. establish how a deferred attempt
resumes under the user-initiated job contract before choosing a scheduling
change. do not add an in-memory sleep or an invalid delayed user-initiated job.

## acceptance

a refusal carrying `Retry-After: N` produces no attempt before N seconds have
passed, including process recreation, and a refusal without the header keeps
today's backoff. job construction and eventual retry obey android's
user-initiated scheduling restrictions; pending bytes remain intact.
