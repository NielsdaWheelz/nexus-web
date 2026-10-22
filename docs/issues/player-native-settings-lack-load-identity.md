# native settings lack load identity

at `5ead65981`, native setting commands identify a media item, not a particular load. a command
delayed across a→b→a can pass the key check and affect the replacement a. local
queued-intent guards cannot recall a command already sent. this is a source-level
hazard. the persistent-player branch now supplies engine-owned `load_id` and
checks `expected_load_id` under the load lock for every keyed command; same-media
installs and retries retire prior identity. delayed reconnect replies and pushes
cannot republish a retired controller/load. recorder completion advances only
its originating occurrence. retain this issue until real native qualification.

evidence: `apps/web/src/lib/player/nativeEngine.ts`, `preference`, captures a
media key. `NexusPlaybackService.kt`, `handle`, orders rate/silence settings under
the load lock and checks that key there. at `5ead65981`, `load` is already
suspending and takes that lock (`NexusPlaybackService.kt:292`); native `advance`
launches the same load (`:420`). both paths serialize source replacement, but
request handling still does not identify a particular same-key load. processing
work must retain this ordering and reject work belonging to a replaced load.

paired podcast persistence uses captured subscription identity/version and does
not depend on this fence. the playback-processing owner should establish source
ordering at the native boundary and add load identity if ordering cannot exclude
the stale-command case. do not add a second playback owner in settings ui.

resolved when a real delayed-command a→b→a scenario cannot apply the previous
load's setting to the replacement load, including native auto-advance; ordinary
settings commands still acknowledge their actual effect. qualify on android.
