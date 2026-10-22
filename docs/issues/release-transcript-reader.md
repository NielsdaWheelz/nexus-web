# transcript reader paired release

status: planned; implementation and qualification not run.

the local transcript-reader plan changes the generated reader/snapshot wire and
adds acknowledged native timed playback. `apps/web/src/lib/player/nativeEngine.ts:36,51`
and `apps/android/app/src/main/java/app/nexus/android/playback/PlayerBridge.kt:31`
currently use `nexusPlayer`; the planned
hard cut uses `nexusPlayback`. mixed versions must reach the existing update-required
path, never a compatibility bridge. an unloaded timed start will require connectivity.

before activation: apply the once-per-release `WIRE_REVISION` rule against actual
release state; regenerate types; pair api/web with the new apk. migration `0307` adds chapter end-absence
provenance:
existing chapter facts and ids survive, but historical null ends stay unverified
(`end_absence_confirmed = false`). their exact scopes remain unavailable until a
new publisher observation confirms an absent end. no data is deleted. supplied
invalid publisher ends now refuse the source observation before persistence.
qualify loaded offline seeking, fresh unloaded starts, stale-command
ordering and old-app refusal on the paired build. keep local/browser proof separate
from installed android proof. deployment is outside the current documentation task.

resolved when the paired release is activated and these boundaries are verified;
record build identities and observed results in its pr. retain this issue until then.
