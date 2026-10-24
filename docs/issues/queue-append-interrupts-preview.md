# appending to an exhausted queue interrupts preview playback

problem: adding the first current occurrence to a retained empty/exhausted queue
activates the episode paused, replacing a playing external preview.

evidence: `apps/web/src/lib/player/playerRuntime.tsx`, browser `execute` queue
append/insert-next branch, computes `addingFromEnd`, then activates when the
cursor changes. `apps/android/app/src/main/java/app/nexus/android/playback/NexusPlaybackService.kt:901`
sets `activate = true` when appending with no current cursor; `:979` pauses the
player before activation. native connected accounts always have a nonnull queue
header (`PlaybackStore.kt:58`), including the initial empty queue.

impact: queue editing can unexpectedly stop a preview. this is pre-existing
behavior; the desktop presentation change preserves it. newly creating an absent
browser queue now saves without loading and preserves preview playback.

resolve by making append/insert-next preserve the active preview while saving
the new cursor, consistently in browser and native owners. qualify real preview
playback across empty/exhausted append and insert-next; queue identity/order must
update while preview subject and playback continue. source-level finding only.
