# native settings lack load identity

native setting commands identify a media item, not a particular load. a command
delayed across a→b→a can pass the key check and affect the replacement a. local
queued-intent guards cannot recall a command already sent. this is a source-level
hazard; it has not been reproduced on a device.

evidence: `apps/web/src/lib/player/nativeEngine.ts`, `preference`, captures a
media key. `NexusPlaybackService.kt`, `handle`, orders rate/silence settings under
the load lock and checks that key there. `load` replaces the source under the
same lock for bridge loads; native `advance` calls the synchronous `load` directly.
request handling does not identify a particular same-key load. any processing
change that makes source replacement asynchronous must order native advance too.

paired podcast persistence uses captured subscription identity/version and does
not depend on this fence. the playback-processing owner should establish source
ordering at the native boundary and add load identity if ordering cannot exclude
the stale-command case. do not add a second playback owner in settings ui.

resolved when a real delayed-command a→b→a scenario cannot apply the previous
load's setting to the replacement load, including native auto-advance; ordinary
settings commands still acknowledge their actual effect. qualify on android.
