status: open
origin: 2026-09-14 native conversion-refusal draft review against `06d85d87dd`
area: native reconciliation completion

`OfflineReadingStore.kt:759–773` claims reconciliationRunning and retains
callbacks before `notifySnapshotChanged()`. that notification performs fresh
sqlite reads. if it throws, `integrityExecutor.execute` is never reached, so
the claimed run has no completion owner and later requests only append
callbacks to it. this is a source-level control-flow hazard, not an observed
runtime receipt. the same snapshot dependency in finalization is being
reviewed in the conversion-refusal draft.

move the initial notification into the existing owned reconciliation try/finally
or explicitly unwind failed dispatch through that same completion owner. do
not invent cached snapshots or a second run state. keep original pending data
and fail-closed exposure; report the original failure without successful sqlite
reads being a prerequisite.

acceptance: an actual failed store-read boundary cannot leave a claimed run or
its callbacks orphaned, and a subsequent request can reconcile after recovery.
