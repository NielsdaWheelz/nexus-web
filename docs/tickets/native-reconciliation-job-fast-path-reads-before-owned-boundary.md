status: open
origin: 2026-09-14 conversion-refusal review against `06d85d87dd`
area: native job reconciliation entry

`OfflineReadingStore.kt:714–730` evaluates `readAccountTransition()` and
`snapshot()` synchronously in the ready fast path of `reconcileForJob`.
its sole production caller, `OfflineReadingTransferJobService.onStartJob`
(lines 78–100), has no catch/report boundary for those sqlite reads. the
conversion-refusal draft protects actual reconciliation execution and its
callbacks, but does not yet cover this separate entry path. no runtime failure
has been asserted for this source-level gap.

route unavailable-store entry through the existing reconciliation failure
outcome, preserving the original cause and durable work. do not add a cached
snapshot or let a failed read become Ready. keep JobService completion owned
by its current callback generation fence.

acceptance: a real unavailable-store read on the ready fast path is reported
without escaping onStartJob, preserves pending rows, and recovery can retry.


candidate: `/tmp/native-reconcile-job-entry-draft`, store `3a850828...`,
activation owner `7268cf0b...`, separately diffed against reviewed
`c2d5cb81...` / `6e480683...`. no sqlite work on the caller; an active run still
adopts the job callback, and prepared readiness keeps the existing shortcut.
actual prepared sqlite permission refusal/recovery is drafted, not executed.

root independently reviewed the final monitor scope: sqlite failure classification
and closed exposure happen before releasing the inspection monitor; callback
completion remains outside it. candidate execution is approved, not yet run.
the prepared-store case also preserves the original sqlite cause and refuses
opening after permission restoration until successful reconciliation.
