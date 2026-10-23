# repeated downloads subscriptions can exhaust the job scheduling quota

`OfflineBridge` calls `OfflineJobs.scheduleSync` on every `hello`. a disposable
driver incorrectly polled that operation every 150 ms while a download waited
for an unreachable storage origin. api 34 run
`20261023-072212-e8f8c3d07046` crashed with:

`IllegalStateException: schedule()/enqueue() called more than 250 times in the past 60000ms`

the stack points to `OfflineJobService.kt:82`, then `OfflineBridge.kt:118`.
the exception escaped the web-message listener and chromium terminated the app
with sigtrap (`jni_android.cc(289)`). the current application subscribes once per
document; this observation does not establish a normal user reproduction. the
driver now consumes actual snapshot pushes and connects the owned storage port.

if fixing the native owner, coalesce repeated wakeups without losing a wake
that arrives while a sync job runs. prove that repeated subscriptions preserve
pending progress and do not exceed the scheduler quota or crash the app.
